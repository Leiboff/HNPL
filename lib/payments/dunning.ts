// ─── Failed-instalment dunning ladder — pure schedule + fee math ────────
//
// All offsets are in days from "the original due date / first failure"
// (Day 0). Pair pattern: two attempts ~1 day apart, ~6 days between
// pairs.  Fee attaches on every SECOND consecutive failed attempt; the
// counter resets when a fee attaches. Cap = min(R300, 50% of the
// original bill).
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

export const DUNNING_FEE_CENTS               = 10_000;  // R100 per applied fee
export const DUNNING_FEE_CAP_ABSOLUTE_CENTS  = 30_000;  // R300 hard cap
export const DUNNING_FEE_CAP_PERCENT         = 0.5;     // OR 50% of original bill
export const INTRA_PAIR_GAP_DAYS             = 1;       // Day 0 → 1, 7 → 8, 14 → 15
export const INTER_PAIR_GAP_DAYS             = 6;       // Day 1 → 7, 8 → 14

// Number of consecutive failed attempts that earns a fee. The brief
// pins this at 2 ("a R100 default fee is charged only after every two
// consecutive failed attempts"). Don't change without rereading the
// brief — the pair schedule and the fee rule are coupled.
export const FAILURES_PER_FEE                = 2;

export type LadderInput = {
  /**
   * Pre-attempt: how many consecutive failures since the last fee was
   * applied (or since the ladder began). 0 on the first failure of a
   * new pair, 1 after a no-fee mid-pair failure.
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
 * the absolute (R300) and the per-bill percentage (50% of the plan
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
 *   • Increment the "consecutive fails since last fee" counter by 1.
 *   • If the counter hits FAILURES_PER_FEE (= 2): attach a fee, clamp
 *     to remaining headroom under the cap, and reset the counter to 0.
 *   • Decide the next attempt date:
 *       - cap reached → terminal `defaulted`, no next attempt
 *       - fee attached this attempt (end of pair) → INTER_PAIR_GAP_DAYS
 *       - no fee (mid-pair)                       → INTRA_PAIR_GAP_DAYS
 *
 * Success outcomes are handled by the caller — they terminate the
 * ladder entirely (clear next_attempt_date, leave counter as-is for
 * post-mortem readability; the row's `status` going to 'collected'
 * makes the counters moot).
 */
export function advanceLadderAfterFailure(input: LadderInput): LadderOutcome {
  const newConsecutive = input.consecutiveFailedAttemptsBefore + 1;
  const capCents       = computeFeeCapCents(input.originalBillRands);

  const earnsFee = newConsecutive >= FAILURES_PER_FEE;

  // Fee is clamped to remaining cap headroom — even though earnsFee
  // tells us "this is the second-of-pair fail", the cap may bind below
  // R100 on a tiny bill (e.g. R150 bill → cap R75). Headroom < fee
  // means the fee shrinks to fit; headroom == 0 means no fee attaches.
  const remainingHeadroom = Math.max(0, capCents - input.dunningFeesCentsBefore);
  const feeThisAttempt    = earnsFee ? Math.min(DUNNING_FEE_CENTS, remainingHeadroom) : 0;

  const dunningFeesCentsAfter = input.dunningFeesCentsBefore + feeThisAttempt;
  const counterAfter          = earnsFee ? 0 : newConsecutive;
  const capReached            = dunningFeesCentsAfter >= capCents;

  let nextAttemptDate: string | null;
  let terminalStatus:  'defaulted' | null;
  if (capReached) {
    nextAttemptDate = null;
    terminalStatus  = 'defaulted';
  } else if (earnsFee) {
    nextAttemptDate = addDaysISO(input.today, INTER_PAIR_GAP_DAYS);
    terminalStatus  = null;
  } else {
    nextAttemptDate = addDaysISO(input.today, INTRA_PAIR_GAP_DAYS);
    terminalStatus  = null;
  }

  return {
    consecutiveFailedAttemptsAfter: counterAfter,
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
