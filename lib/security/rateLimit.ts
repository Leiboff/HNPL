// ─── The one rate-limit call site ───────────────────────────────────────
//
// Backed by migration 0124's consume_rate_limit RPC, so the budget is
// shared across every serverless instance rather than per-lambda. See that
// migration for why this lives in Postgres. Application-side failures now
// fail closed and emit a structured, alertable decision event.
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
import { createHmac } from 'node:crypto';

export type RateLimitBucket =
  | 'signup'
  | 'resend_confirmation'
  | 'checkout_initiate'
  | 'identity_session'
  | 'till_registration'
  | 'public_lead'
  | 'contact_form'
  // ── The money-moving surfaces, added 2026-09-02 (audit A-11's second
  //    half). Every one of these charges a card, commits credit or issues
  //    a bill token, and none of them had any limit at all.
  | 'accept_plan'
  | 'pay_saved_card'
  | 'self_settle'
  | 'counter_session'
  | 'credit_check'
  | 'reverse_geocode'
  | 'referral_invite';

export type RateLimitRule = { max: number; windowSecs: number };
export type RateLimitOutcome = 'allowed' | 'limited' | 'unavailable' | 'missing_subject';
export type RateLimitDecision = { allowed: boolean; outcome: RateLimitOutcome };

type RateLimitSubjectKind = 'ip' | 'account';

/** Keep dependency failures shorter than the calling action's own timeout. */
export const RATE_LIMIT_RPC_TIMEOUT_MS = 2_500;

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

  // ─── The money-moving surfaces ───────────────────────────────────────
  //
  // These are not anti-abuse limits in the signup sense — the caller is an
  // authenticated patient acting on their own plan, and the authorization
  // is already correct. They are BLAST-RADIUS limits: whatever goes wrong
  // upstream (a compromised session, a retry storm from a flaky client, a
  // bug that loops), the damage per account per hour is bounded, and the
  // counter is a signal that something is wrong before the money is.
  //
  // Sized against the legitimate repeat profile, which for all five is
  // "once, occasionally twice". Generous multiples of that, so a real
  // person fumbling a payment never meets one.

  // Commits credit and writes a schedule. A patient accepts a bill once;
  // a decline-retry does not re-accept.
  accept_plan:         { ip: { max: 20, windowSecs: 3600 }, account: { max: 10, windowSecs: 3600 } },

  // Fires a real CIT charge at Peach. The resume path re-enters this with
  // the SAME deterministic reference, so Peach dedups rather than
  // double-charging — the limit is about the volume of attempts, not about
  // correctness of any one of them.
  pay_saved_card:      { ip: { max: 20, windowSecs: 3600 }, account: { max: 10, windowSecs: 3600 } },

  // Fires an MIT charge for the whole outstanding balance. The single
  // largest amount a patient can move in one call, and once it succeeds
  // there is nothing left to settle.
  self_settle:         { ip: { max: 10, windowSecs: 3600 }, account: { max: 5,  windowSecs: 3600 } },

  // A practice issuing a till bill. Keyed on the PRACTICE rather than the
  // user, because a busy front desk is several receptionists on one
  // account — and because "this practice is raising bills at 300/hour" is
  // the thing worth noticing, whoever is typing.
  counter_session:     { ip: { max: 120, windowSecs: 3600 }, account: { max: 200, windowSecs: 3600 } },

  // A credit bureau call. Real money at a vendor per unit, and a patient
  // needs exactly one — the retries are for a failed lookup, not for a
  // second opinion.
  credit_check:        { ip: { max: 10, windowSecs: 86400 }, account: { max: 5, windowSecs: 86400 } },

  // Billable server-side Google Geocoding API calls.
  reverse_geocode:     { ip: { max: 60, windowSecs: 300 }, account: { max: 30, windowSecs: 300 } },

  // ─── Referrals (0145) ────────────────────────────────────────────────
  //
  // A patient inviting a friend puts an email into a STRANGER'S inbox from
  // our verified sending domain, at the request of somebody whose only
  // qualification is having an account. That is a mail-bombing primitive
  // aimed at our own deliverability, and it is the reason this bucket is
  // the tightest per-account limit in the table.
  //
  // Nominating a practice spends the same budget. It sends no mail, but it
  // creates a crm_leads row a rep has to work, and a queue nobody trusts is
  // as costly to sales as spam is to the mail domain.
  //
  // Sized against the legitimate profile: a real person invites a handful of
  // friends in one sitting and then stops. Ten a day covers an enthusiastic
  // customer; nothing covers a script, which is the point.
  referral_invite:     { ip: { max: 30, windowSecs: 86400 }, account: { max: 10, windowSecs: 86400 } },
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

function subjectFingerprint(subject: string | null | undefined): string | null {
  if (!subject) return null;
  // Key the digest so low-entropy values such as IPv4 addresses and phone
  // numbers cannot be recovered with an offline dictionary. A dedicated key
  // is preferred; the already-required service key is a safe fallback.
  const key = process.env.RATE_LIMIT_LOG_HMAC_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createHmac('sha256', key).update(subject).digest('hex').slice(0, 16);
}

function emitDecision(input: {
  bucket: RateLimitBucket;
  outcome: Exclude<RateLimitOutcome, 'allowed'>;
  subject: string | null | undefined;
  subjectKind: RateLimitSubjectKind;
  rule: RateLimitRule;
  dependencyStage?: 'client_init' | 'rpc' | 'rpc_timeout';
  dependencyCode?: string;
}): void {
  const event = {
    event: 'rate_limit_decision',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    bucket: input.bucket,
    outcome: input.outcome,
    subject_kind: input.subjectKind,
    subject_hash: subjectFingerprint(input.subject),
    limit_max: input.rule.max,
    window_seconds: input.rule.windowSecs,
    ...(input.dependencyStage ? { dependency_stage: input.dependencyStage } : {}),
    ...(input.dependencyCode ? { dependency_code: input.dependencyCode.slice(0, 64) } : {}),
  };

  const line = JSON.stringify(event);
  if (input.outcome === 'unavailable') console.error(line);
  else console.warn(line);
}

class RateLimitRpcTimeoutError extends Error {
  constructor() {
    super('rate-limit RPC timed out');
    this.name = 'RateLimitRpcTimeoutError';
  }
}

async function withRpcTimeout<T>(operation: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RateLimitRpcTimeoutError()), RATE_LIMIT_RPC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Detailed decision for observability-aware callers and tests. No successful
 * decision is logged: allowed traffic is high-volume and the database hit is
 * already its durable counter. Every refusal is emitted as one JSON line.
 */
export async function consumeRateLimitDetailed(
  bucket: RateLimitBucket,
  subject: string | null | undefined,
  rule: RateLimitRule,
  client?: Svc,
  subjectKind: RateLimitSubjectKind = 'account',
): Promise<RateLimitDecision> {
  if (!subject) {
    emitDecision({ bucket, outcome: 'missing_subject', subject, subjectKind, rule });
    return { allowed: false, outcome: 'missing_subject' };
  }

  let db: Svc;
  try {
    db = client ?? svc();
  } catch (err) {
    emitDecision({
      bucket,
      outcome: 'unavailable',
      subject,
      subjectKind,
      rule,
      dependencyStage: 'client_init',
      dependencyCode: err instanceof Error ? err.name : 'UnknownError',
    });
    return { allowed: false, outcome: 'unavailable' };
  }

  try {
    const operation = db.rpc('consume_rate_limit', {
      p_bucket: bucket,
      p_subject: subject,
      p_max: rule.max,
      p_window_secs: rule.windowSecs,
    }) as PromiseLike<{
      data: boolean | null;
      error: { code?: string } | null;
    }>;
    const { data, error } = await withRpcTimeout(operation);
    if (error) {
      emitDecision({
        bucket,
        outcome: 'unavailable',
        subject,
        subjectKind,
        rule,
        dependencyStage: 'rpc',
        dependencyCode: typeof error.code === 'string' ? error.code : 'RpcError',
      });
      return { allowed: false, outcome: 'unavailable' };
    }
    if (data === false) {
      emitDecision({ bucket, outcome: 'limited', subject, subjectKind, rule });
      return { allowed: false, outcome: 'limited' };
    }
    return { allowed: true, outcome: 'allowed' };
  } catch (err) {
    const timedOut = err instanceof RateLimitRpcTimeoutError;
    emitDecision({
      bucket,
      outcome: 'unavailable',
      subject,
      subjectKind,
      rule,
      dependencyStage: timedOut ? 'rpc_timeout' : 'rpc',
      dependencyCode: err instanceof Error ? err.name : 'UnknownError',
    });
    return { allowed: false, outcome: 'unavailable' };
  }
}

/**
 * Spend one unit from `bucket:subject`. True when the caller may proceed.
 *
 * Fails CLOSED on an RPC error. These buckets front actions that can spend
 * money, create credit exposure, or send paid third-party requests.
 */
export async function consumeRateLimit(
  bucket:  RateLimitBucket,
  subject: string | null | undefined,
  rule:    RateLimitRule,
  client?: Svc,
): Promise<boolean> {
  return (await consumeRateLimitDetailed(bucket, subject, rule, client)).allowed;
}

/**
 * Spend from every supplied key and refuse if any is exhausted.
 *
 * `keys` are `[subject, rule]` pairs — typically the IP and the account /
 * token / email. A missing key refuses the request: every protected action
 * needs a subject for the shared limiter to enforce.
 */
export async function consumeAll(
  bucket: RateLimitBucket,
  keys:   Array<[subject: string | null | undefined, rule: RateLimitRule]>,
  client?: Svc,
): Promise<boolean> {
  // Build once so both subjects use the same client. Detailed evaluation
  // emits a structured unavailable event if construction fails.
  let shared: Svc | undefined;
  try {
    shared = client ?? svc();
  } catch {
    // Leave undefined: each key is evaluated and logged with its subject
    // kind and privacy-safe fingerprint rather than one context-free error.
  }

  // Sequential rather than parallel: these are two cheap statements
  // against one connection, and Promise.all here would spend budget in a
  // nondeterministic order for no measurable gain.
  let allowed = true;
  for (const [index, [subject, rule]] of keys.entries()) {
    const decision = await consumeRateLimitDetailed(
      bucket,
      subject,
      rule,
      shared,
      index === 0 ? 'ip' : 'account',
    );
    if (!decision.allowed) allowed = false;
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
 * Failure to resolve the caller's IP returns null. The fail-closed decision
 * path records `missing_subject`, so proxy/header drift becomes visible and
 * the action never silently runs without its IP budget.
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
 * it is the honest value. Returns null when neither header is present;
 * protected actions deny rather than running without an abuse-control key.
 */
export function clientIpFrom(headers: Headers): string | null {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || null;
}
