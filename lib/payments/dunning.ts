// ─── Failed-instalment dunning ladder — pure schedule + fee math ────────
//
// All offsets are in days from "the original due date / first failure"
// (Day 0). Cadence: the first failure is a fee-free grace (retry +1 day);
// every failure after that carries a fee and retries WEEKLY, until the
// cap (3 fees) is reached → terminal `defaulted`. Fee-bearing days on a
// normal bill: Day 1, 8, 15. Cap = min(R345 = 3×fee, 50% of the original
// bill).
//
// This module is PURE — no DB, no fetch, no I/O. The caller passes in
// the pre-attempt state and "today", and gets back the post-attempt
// state to persist. That lets the same engine drive:
//   • the payment-failure webhook (advance on a real charge failure)
//   • tests (deterministic, no clock + no stub Supabase needed)
//   • a future preauth/DebiCheck swap (the rail-agnostic guarantee:
//     only "today + attempt failed?" + the per-row counters matter,
//     not which channel pulled the money).

// Named constants — one place so a finance/legal change is one edit.
// All values in cents to avoid float drift.

export const DUNNING_FEE_CENTS               = 11_500;  // R115 per applied fee

// Max number of fees the ladder may apply before terminal (policy: 3).
export const DUNNING_MAX_FEES                = 3;

// Absolute cap = 3 × the fee, so it AUTO-TRACKS the fee constant rather
// than being a hardcoded rand figure (3 × R115 = R345). Change the fee
// and the cap follows. The effective cap is still the LOWER of this and
// 50% of the plan (computeFeeCapCents).
export const DUNNING_FEE_CAP_ABSOLUTE_CENTS  = DUNNING_FEE_CENTS * DUNNING_MAX_FEES;  // R345
export const DUNNING_FEE_CAP_PERCENT         = 0.5;     // OR 50% of original bill

// Cadence: the first failure (the missed due date) is a fee-free grace —
// we retry ONE day later. If that +1-day retry also fails, that's the
// first default → fee #1, and from there we retry WEEKLY, a fee on each,
// until the cap (3 fees) is reached → terminal `defaulted`.
export const FIRST_RETRY_GAP_DAYS            = 1;       // Day 0 → Day 1
export const WEEKLY_RETRY_GAP_DAYS           = 7;       // Day 1 → 8 → 15 …

// ─── Fee gate (compliance) ──────────────────────────────────────────────
//
// Charging a default fee requires disclosed + accepted T&Cs, which are
// not yet persisted. Until they are, ALL fee CHARGING is gated OFF:
// the ladder still advances, retries still run, comms still fire, and the
// instalment still transitions to `defaulted` at the ladder's terminal
// point — but ZERO rand of fee ever hits a patient card, and the
// dunning_fees_cents ledger is not grown while the gate is closed.
//
// Read at call time (not module load) so tests + a future ops flip can
// toggle it via env without a rebuild. Default OFF: enabling requires a
// deliberate `DUNNING_FEES_ENABLED=true`, never an accidental empty/typo
// value. This is the single source of truth every charge point consults.
export function dunningFeesEnabled(): boolean {
  return process.env.DUNNING_FEES_ENABLED === 'true';
}

// Number of leading fee-FREE failures. The first missed collection is a
// grace attempt (no fee) that only earns a +1-day retry; every failure
// after that carries a fee. Policy pins this at 1.
export const FEE_FREE_FIRST_FAILURES         = 1;

export type LadderInput = {
  /**
   * Pre-attempt: total failures on this instalment SO FAR (before this
   * one), monotonic — it is NOT reset when a fee attaches. 0 on the
   * first failure (the missed due date), 1 on the +1-day retry, etc.
   */
  consecutiveFailedAttemptsBefore: number;
  /** Pre-attempt: cumulative fees on this instalment (cents). */
  dunningFeesCentsBefore: number;
  /**
   * The instalment's plan total in RANDS — drives the per-bill 50%
   * cap. Caller reads `plans.total_amount` and passes it through.
   */
  originalBillRands: number;
  /** Today's UTC ISO date (YYYY-MM-DD). Drives the next-attempt-date math. */
  today: string;
};

export type LadderOutcome = {
  /** Post-attempt TOTAL failures so far (monotonic, never reset). */
  consecutiveFailedAttemptsAfter: number;
  dunningFeesCentsAfter:          number;
  /** Cents of fee attached to THIS attempt (0 if no fee). */
  feeAppliedThisAttempt:          number;
  /** True iff dunning_fees_cents has reached the cap after this attempt. */
  capReached:                     boolean;
  /** When the cron should retry; null if the ladder has terminated. */
  nextAttemptDate:                string | null;
  /** Set to 'defaulted' iff the cap was reached on this attempt. */
  terminalStatus:                 'defaulted' | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Compute the per-instalment fee cap in cents. The cap is the LOWER of
 * the absolute (R345 = 3×fee) and the per-bill percentage (50% of the plan
 * total). Floor to whole cents so we never quote sub-cent amounts.
 */
export function computeFeeCapCents(originalBillRands: number): number {
  const percentCap = Math.floor(originalBillRands * DUNNING_FEE_CAP_PERCENT * 100);
  return Math.min(DUNNING_FEE_CAP_ABSOLUTE_CENTS, Math.max(0, percentCap));
}

/**
 * Add N days to an ISO date string (YYYY-MM-DD). Goes via Date.UTC()
 * so daylight-saving doesn't shift the offset — same discipline as
 * lib/salaryDates / lib/finance.
 */
export function addDaysISO(today: string, days: number): string {
  const [y, m, d] = today.split('-').map(Number);
  const utc = Date.UTC(y, (m ?? 1) - 1, (d ?? 1));
  const out = new Date(utc + days * 86_400_000);
  return out.toISOString().slice(0, 10);
}

// ─── The ladder advance — one rule, applied to every real outcome ───────

/**
 * Compute the post-attempt ladder state after a FAILED attempt.
 *
 * Cadence (decided policy):
 *   • The FIRST failure (the missed due date) is a fee-free grace: no
 *     fee, retry in FIRST_RETRY_GAP_DAYS (+1 day).
 *   • Every failure AFTER that carries a fee (the first default → fee #1),
 *     clamped to remaining headroom under the cap, and retries WEEKLY
 *     (WEEKLY_RETRY_GAP_DAYS).
 *   • When the accrued fee reaches the cap (3 fees, or the 50%-of-plan
 *     bound sooner) → terminal `defaulted`, no next attempt.
 *
 *   Timeline on a normal bill: Day 0 (fail, no fee, +1) → Day 1 (fail,
 *   fee #1, +7) → Day 8 (fail, fee #2, +7) → Day 15 (fail, fee #3 → cap
 *   → defaulted).
 *
 * The counter is TOTAL failures so far (monotonic, never reset) so
 * "before === 0" always identifies the first failure — the caller keys
 * the Day-0 SMS off exactly that.
 *
 * Success outcomes are handled by the caller — they terminate the
 * ladder entirely (clear next_attempt_date, leave the counter as-is for
 * post-mortem readability; the row's `status` going to 'collected'
 * makes the counters moot).
 */
export function advanceLadderAfterFailure(input: LadderInput): LadderOutcome {
  const failuresAfter = input.consecutiveFailedAttemptsBefore + 1;
  const capCents      = computeFeeCapCents(input.originalBillRands);

  // The first FEE_FREE_FIRST_FAILURES failures earn no fee; every later
  // failure does. With FEE_FREE_FIRST_FAILURES = 1: failure #1 is free,
  // failures #2, #3, #4… each carry a fee.
  const isGraceFailure = input.consecutiveFailedAttemptsBefore < FEE_FREE_FIRST_FAILURES;
  const earnsFee       = !isGraceFailure;

  // Fee is clamped to remaining cap headroom — the cap may bind below a
  // full fee on a small bill (e.g. R150 bill → cap R75, or the last fee
  // before the R345 cap). Headroom < fee → the fee shrinks to fit;
  // headroom == 0 → no fee attaches.
  const remainingHeadroom = Math.max(0, capCents - input.dunningFeesCentsBefore);
  const feeThisAttempt    = earnsFee ? Math.min(DUNNING_FEE_CENTS, remainingHeadroom) : 0;

  const dunningFeesCentsAfter = input.dunningFeesCentsBefore + feeThisAttempt;
  const capReached            = dunningFeesCentsAfter >= capCents;

  let nextAttemptDate: string | null;
  let terminalStatus:  'defaulted' | null;
  if (capReached) {
    nextAttemptDate = null;
    terminalStatus  = 'defaulted';
  } else if (isGraceFailure) {
    // First failure → the single +1-day retry.
    nextAttemptDate = addDaysISO(input.today, FIRST_RETRY_GAP_DAYS);
    terminalStatus  = null;
  } else {
    // A fee-bearing failure that hasn't hit the cap → weekly retry.
    nextAttemptDate = addDaysISO(input.today, WEEKLY_RETRY_GAP_DAYS);
    terminalStatus  = null;
  }

  return {
    consecutiveFailedAttemptsAfter: failuresAfter,
    dunningFeesCentsAfter,
    feeAppliedThisAttempt:          feeThisAttempt,
    capReached,
    nextAttemptDate,
    terminalStatus,
  };
}

// ─── Charge amount math ────────────────────────────────────────────────

/**
 * Amount in cents to charge on the next attempt. The patient owes the
 * instalment PLUS the fees accrued by previous attempts; a successful
 * charge therefore recovers everything in one transaction.
 */
export function chargeAmountCents(instalmentRands: number, dunningFeesCentsAccrued: number): number {
  return Math.round(instalmentRands * 100) + Math.max(0, dunningFeesCentsAccrued);
}
