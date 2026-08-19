// ─── Public contact form — per-IP rate limit (in-memory) ─────────────
//
// Lives outside any `'use server'` module because Next.js requires that
// server-action files export ONLY async functions. The action imports
// checkAndRecord(); tests import resetForTests() to isolate buckets
// between cases.
//
// ─── Why this is a TWIN of lib/crm/publicLeadRateLimit and not a
//     shared limiter ────────────────────────────────────────────────
//
// The obvious move is to import the CRM limiter and be done. That would be
// wrong: its buckets are keyed on IP alone, so the two public surfaces would
// share one budget. A visitor who submitted five practice-lead forms on
// /practices could then not send a support enquiry from /contact at all —
// two unrelated surfaces silently starving each other, and the failure would
// look like a bug to the person who hit it.
//
// Separate buckets also let the limits diverge on their own merits. A lead
// form and a support enquiry have different legitimate-repeat profiles: a
// practice fills the lead form once, whereas someone chasing an unresolved
// support issue may reasonably write twice in an afternoon.
//
// The algorithm is deliberately identical, and small enough that duplicating
// it costs less than a shared abstraction with a key-prefix parameter would.
// This mirrors the repo's existing "documented twin" precedent for the
// token-keyed and user-keyed phone-OTP action pairs.
//
// ─── What this does NOT do ────────────────────────────────────────────
//
// State is per-instance and best-effort. Multi-instance Vercel serving means
// a determined attacker can bypass it by landing on different lambdas, and a
// deploy resets every bucket. It is defence-in-depth against casual abuse and
// accidental double-posting, NOT an admission gate — the honeypot and the
// server-side validation in the action are the other layers, and none of the
// three is load-bearing alone.

/** Submissions allowed per IP per window.
 *
 *  Same numbers as the practice-lead form today, arrived at independently:
 *  five in an hour comfortably covers a genuine follow-up message plus a
 *  retry after a typo, and stops a loop. The point of this module is that the
 *  BUDGETS are separate, not that the numbers differ — either can now be
 *  tuned on its own evidence without touching the other. */
const RATE_LIMIT_MAX       = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;   // 1 h

// ─── WHAT "5/hour per IP" ACTUALLY MEANS ─────────────────────────────
//
// 5/hour per IP PER WARM SERVERLESS INSTANCE. This is an in-process Map: each
// lambda that serves a request has its own copy, so N warm instances mean up
// to 5N submissions per hour from one IP, and every deploy or cold start
// resets every bucket to empty.
//
// That is defence-in-depth against casual abuse and accidental double-posting,
// NOT a hard admission gate — do not cite it as one, and do not build anything
// that depends on the ceiling actually holding. A durable store
// (KV / Postgres) is a post-launch item if spam actually appears; until then
// the honeypot and the server-side validation are the other two layers.
const rateBuckets = new Map<string, number[]>();

/** Returns true if the IP is within budget (and records the hit);
 *  false if the IP has exhausted its window budget. */
export function checkAndRecord(ip: string, now: number = Date.now()): boolean {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const existing = rateBuckets.get(ip) ?? [];
  const fresh = existing.filter((t) => t > cutoff);
  if (fresh.length >= RATE_LIMIT_MAX) {
    // Write the pruned list back even on refusal, so a bucket cannot grow
    // without bound while an IP keeps being turned away.
    rateBuckets.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  return true;
}

export function resetForTests(): void {
  rateBuckets.clear();
}

export const CONTACT_RATE_LIMIT_MAX       = RATE_LIMIT_MAX;
export const CONTACT_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;
