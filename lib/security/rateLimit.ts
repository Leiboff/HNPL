// ─── The one rate-limit call site ───────────────────────────────────────
//
// Backed by migration 0124's consume_rate_limit RPC, so the budget is
// shared across every serverless instance rather than per-lambda. See that
// migration for why this lives in Postgres and why it fails open.
//
// WHAT TO KEY ON
//
// Both IP and account, wherever both exist, as SEPARATE buckets that must
// each have budget. Keying on one alone is what makes a limiter
// decorative: an IP is a VPN hop away and an account is a signup away, but
// an attacker needs to rotate both to get throughput.
//
// consumeAll below is the shape that expresses that — it spends from every
// key it is given and refuses if ANY of them is exhausted. It deliberately
// does NOT short-circuit on the first refusal: spending the rest keeps the
// counters honest for the surface that is actually under attack, and these
// windows are short enough that the extra hits cost nothing.

import { createClient as createServiceClient } from '@supabase/supabase-js';

export type RateLimitBucket =
  | 'signup'
  | 'resend_confirmation'
  | 'checkout_initiate'
  | 'identity_session'
  | 'till_registration'
  | 'public_lead'
  | 'contact_form';

export type RateLimitRule = { max: number; windowSecs: number };

/**
 * The limits, in one table so they can be reviewed as a set rather than
 * discovered one call site at a time.
 *
 * Sized against the LEGITIMATE repeat profile of each surface, not against
 * a round number. A real person signing up fumbles it two or three times;
 * five is comfortable headroom. A rep importing a lead list never touches
 * till registration at all. The identity limit is the tightest because it
 * is the only one where each call spends real money at a vendor.
 */
export const RATE_LIMITS: Record<RateLimitBucket, { ip: RateLimitRule; account?: RateLimitRule }> = {
  // Each call may send a Supabase transactional email and create an auth
  // user. Per-IP only — there is no account yet.
  signup:              { ip: { max: 10, windowSecs: 3600 } },

  // Anonymous, and each call emails a real inbox. Keyed per-IP AND per
  // target address, so one address cannot be mail-bombed from many IPs.
  resend_confirmation: { ip: { max: 10, windowSecs: 3600 }, account: { max: 5, windowSecs: 3600 } },

  // Creates an auth user and a Peach checkout. Keyed per-IP and per token
  // — a stolen token should not be usable as an unlimited account factory.
  checkout_initiate:   { ip: { max: 20, windowSecs: 3600 }, account: { max: 10, windowSecs: 3600 } },

  // A PAID KYC unit per call. The tightest limit here, deliberately: a
  // patient needs one session, plus a couple of retries for a bad photo.
  identity_session:    { ip: { max: 10, windowSecs: 86400 }, account: { max: 5, windowSecs: 86400 } },

  // Guesses against an 8-digit code in a GLOBAL keyspace. A manager
  // registering a till types it once, maybe twice. Anything past that is
  // not a receptionist.
  till_registration:   { ip: { max: 10, windowSecs: 3600 } },

  // Twins of the two in-memory limiters these replace, same numbers.
  public_lead:         { ip: { max: 5,  windowSecs: 3600 } },
  contact_form:        { ip: { max: 5,  windowSecs: 3600 } },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

function svc(): Svc {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

/**
 * Spend one unit from `bucket:subject`. True when the caller may proceed.
 *
 * Fails OPEN on an RPC error — see the 0124 header. The error is logged so
 * a limiter that has silently stopped limiting is visible in the logs
 * rather than only in the bill.
 */
export async function consumeRateLimit(
  bucket:  RateLimitBucket,
  subject: string | null | undefined,
  rule:    RateLimitRule,
  client?: Svc,
): Promise<boolean> {
  if (!subject) return true;
  try {
    // svc() is constructed INSIDE the try, not in a `client ?? svc()`
    // default. createClient throws outright when the Supabase env vars are
    // absent, and a limiter that cannot even build a client has to fail
    // open like every other failure here — otherwise "this action now has
    // a rate limit" becomes "this action now throws wherever the env is
    // not fully configured", which is every unit test of every guarded
    // action and any environment mid-provision.
    const db = client ?? svc();
    const { data, error } = await db.rpc('consume_rate_limit', {
      p_bucket:      bucket,
      p_subject:     subject,
      p_max:         rule.max,
      p_window_secs: rule.windowSecs,
    });
    if (error) {
      console.error('[rate-limit] RPC failed — allowing through', { bucket, error: error.message });
      return true;
    }
    return data !== false;
  } catch (err) {
    console.error('[rate-limit] threw — allowing through', {
      bucket, error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Spend from every supplied key and refuse if any is exhausted.
 *
 * `keys` are `[subject, rule]` pairs — typically the IP and the account /
 * token / email. A null subject is skipped rather than treated as a
 * refusal (an unresolvable IP is our problem, not the caller's).
 */
export async function consumeAll(
  bucket: RateLimitBucket,
  keys:   Array<[subject: string | null | undefined, rule: RateLimitRule]>,
  client?: Svc,
): Promise<boolean> {
  // Same fail-open construction as consumeRateLimit: a client we cannot
  // build must not throw out of here.
  let shared: Svc | undefined;
  try {
    shared = client ?? svc();
  } catch {
    console.error('[rate-limit] could not build a client — allowing through', { bucket });
    return true;
  }

  // Sequential rather than parallel: these are two cheap statements
  // against one connection, and Promise.all here would spend budget in a
  // nondeterministic order for no measurable gain.
  let allowed = true;
  for (const [subject, rule] of keys) {
    const ok = await consumeRateLimit(bucket, subject, rule, shared);
    if (!ok) allowed = false;
  }
  return allowed;
}

/**
 * The request's client IP, or null when there isn't one to be had.
 *
 * Resolves `next/headers` through a dynamic import inside a try/catch,
 * deliberately, and this is the shape every caller should use rather than
 * importing `headers` themselves.
 *
 * Two reasons, and the second is the one that was learned the hard way.
 *
 * A rate limiter must never be able to take down the action it guards. It
 * is a damping mechanism on abuse; if resolving the caller's IP throws,
 * the correct outcome is an unkeyed pass, not a 500 on somebody's signup.
 *
 * And a static `import { headers } from 'next/headers'` at the top of a
 * server action is a hard dependency for every test of that action.
 * Several suites here mock `next/headers` with only the export they need
 * (usually `cookies`), so adding the import turned "this action now has a
 * rate limit" into twenty red tests about terms acceptance. Importing it
 * lazily, here, keeps the limiter's dependency inside the limiter.
 */
export async function clientIp(): Promise<string | null> {
  try {
    const { headers } = await import('next/headers');
    return clientIpFrom(await headers());
  } catch {
    return null;
  }
}

/**
 * Best-effort client IP from the proxy headers Vercel sets.
 *
 * Takes the FIRST entry of x-forwarded-for — the closest thing to the
 * origin client — and falls back to x-real-ip. Spoofable in principle;
 * on Vercel the platform rewrites x-forwarded-for, so in this deployment
 * it is the honest value. Returns null rather than a placeholder when
 * neither header is present, so consumeRateLimit skips instead of
 * lumping every unresolved caller into one shared 'anon' bucket — which
 * would let one attacker exhaust the budget for everybody behind a proxy
 * we failed to parse.
 */
export function clientIpFrom(headers: Headers): string | null {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || null;
}
