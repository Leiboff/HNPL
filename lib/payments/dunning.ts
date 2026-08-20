// ─── Failed-instalment dunning ladder — pure schedule + fee math ────────
//
// All offsets are in days from "the original due date" (Day 0). Cadence,
// per T&Cs clause 7.2: the due-date attempt IS the first collection try —
// there is no separate fee-free RETRY the day after. If that attempt
// fails, Default Fee #1 attaches — after a 24-hour self-pay grace period
// (see below) — and we re-attempt weekly, each still-unpaid failure
// carrying another fee after its own grace, until the cap (3 fees) is
// reached → terminal `defaulted`. Fee-bearing days on a normal bill (grace
// folded in): due date, +8, +15 — see FEE_GRACE_PERIOD_DAYS.
//
// Bounded a second way too: the ladder never schedules a retry that would
// land on or after the PLAN'S NEXT instalment's own due date. Once that
// boundary is crossed, THIS instalment stops being separately chased (the
// next instalment gets its own independent due-date attempt) and — per
// product policy (any unresolved default freezes the patient, see
// lib/patient/freeze.ts: "they can't spend when they owe us money and
// haven't paid") — it terminates as `defaulted` right there, even short of
// the 3-fee cap. So a Pay-in-2/3 plan with a short gap between instalments
// (clause 2.4: as little as a few days) can default before ever reaching a
// third fee.
//
// ─── THE 24-HOUR SELF-PAY GRACE — WHERE IT LIVES, AND WHY NOT HERE ──────
//
// Direct product decision: a failed attempt does not earn its fee (or
// terminate the ladder) the instant it fails. The patient gets
// FEE_GRACE_PERIOD_DAYS to settle manually (Pay now) before this module
// is even consulted. T&Cs clause 7.5 covers this ("we may... waive or
// defer any Default Fee") — it is a leniency layered ON TOP of the
// disclosed worst case, not a change to it.
//
// That grace is deliberately NOT modelled as a parameter of
// advanceLadderAfterFailure. The function stays pure schedule-and-fee
// math over "today" — what changed is WHEN a caller is allowed to call
// it: the Peach webhook's payment.failure handler no longer calls this
// module at all. It just records the failure and stamps
// payments.dunning_grace_until = today + FEE_GRACE_PERIOD_DAYS. A daily
// cron pass (lib/payments/assessDunningFee.ts) is the ONLY caller of
// advanceLadderAfterFailure now, and only for rows whose grace has
// elapsed and are STILL unpaid — "today" passed in is the assessment
// date, not the original failure date, so the weekly retry cadence below
// is measured from whenever a failure actually got assessed, which
// already has the grace day folded in.
//
// This module is PURE — no DB, no fetch, no I/O. The caller passes in
// the pre-attempt state and "today" (plus the next instalment's due date,
// if any), and gets back the post-attempt state to persist. That lets the
// same engine drive:
//   • the daily grace-elapsed assessment pass (advance on a still-unpaid
//     failure once its 24-hour self-pay window has closed)
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

// Cadence: every failure — starting with the due-date attempt itself —
// carries a fee (clamped to remaining cap headroom) once its self-pay
// grace has elapsed, and retries weekly from THAT point. There is no
// fee-free RETRY attempt; see the module banner for why (T&Cs 7.2 ties
// the fee to the due-date attempt failing, not to a later retry).
export const WEEKLY_RETRY_GAP_DAYS           = 7;       // grace-elapsed day 0 → 7 → 14 …

// The 24-hour self-pay window between a failed attempt and its Default
// Fee being assessed. Consulted by the webhook (to stamp
// dunning_grace_until) and the assessment cron pass — NOT by
// advanceLadderAfterFailure itself, which never sees "the day it failed",
// only "the day we're assessing it". See the module banner.
export const FEE_GRACE_PERIOD_DAYS           = 1;

// ─── Fee gate (compliance) ──────────────────────────────────────────────
//
// Charging a default fee requires disclosed + accepted T&Cs. Now that the
// live T&Cs (clause 7) and Privacy Policy are published and accepted at
// signup/plan-activation (lib/legal/terms.ts, lib/legal/privacy.ts), this
// gate is meant to be ON. It still exists — rather than being deleted — as
// a single kill switch: every charge point consults it, so a future need
// to pause fee-charging (a legal review, a bug) is one env var, not a
// code deploy.
//
// Read at call time (not module load) so tests + a future ops flip can
// toggle it via env without a rebuild. Default OFF: enabling requires a
// deliberate `DUNNING_FEES_ENABLED=true`, never an accidental empty/typo
// value. This is the single source of truth every charge point consults.
export function dunningFeesEnabled(): boolean {
  return process.env.DUNNING_FEES_ENABLED === 'true';
}

export type LadderInput = {
  /**
   * Pre-attempt: total failures on this instalment SO FAR (before this
   * one), monotonic — it is NOT reset when a fee attaches. 0 on the
   * due-date attempt (the first collection try), 1 on the Day-7 retry,
   * etc.
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
  /**
   * Due date (YYYY-MM-DD) of the NEXT instalment on this plan, or `null`
   * if this is the plan's last instalment (nothing bounds the retry
   * cadence beyond the fee cap). Caller reads the next `payments` row for
   * the same `plan_id` (`instalment_number + 1`) and passes its due_date.
   */
  nextInstalmentDueDate: string | null;
};

export type LadderOutcome = {
  /** Post-attempt TOTAL failures so far (monotonic, never reset). */
  consecutiveFailedAttemptsAfter: number;
  dunningFeesCentsAfter:          number;
  /** Cents of fee attached to THIS attempt (0 only once cap headroom is exhausted). */
  feeAppliedThisAttempt:          number;
  /** True iff dunning_fees_cents has reached the cap after this attempt. */
  capReached:                     boolean;
  /**
   * True iff the next weekly retry would land on or after the next
   * instalment's own due date, so no further retry was scheduled for
   * THIS instalment. False when there is no next instalment to bound it.
   */
  nextInstalmentBoundaryHit:      boolean;
  /** When the cron should retry; null if the ladder has terminated. */
  nextAttemptDate:                string | null;
  /** Set to 'defaulted' iff capReached OR nextInstalmentBoundaryHit on this attempt. */
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
 * Cadence (decided policy, per T&Cs clause 7.2):
 *   • EVERY failure — including the due-date attempt itself — carries a
 *     fee, clamped to remaining headroom under the cap, and retries
 *     WEEKLY (WEEKLY_RETRY_GAP_DAYS). There is no fee-free grace retry.
 *   • When the accrued fee reaches the cap (3 fees, or the 50%-of-plan
 *     bound sooner) → terminal `defaulted`, no next attempt.
 *   • OR, independently: when the next weekly retry would fall on or
 *     after the plan's NEXT instalment's own due date → terminal
 *     `defaulted` right there, even short of the fee cap. This instalment
 *     stops being separately chased; the next instalment gets its own
 *     due-date attempt on its own schedule.
 *
 *   Timeline on a normal bill (next instalment far enough away not to
 *   bind): Day 0 (fail, fee #1, +7) → Day 7 (fail, fee #2, +7) → Day 14
 *   (fail, fee #3 → cap → defaulted).
 *
 * The counter is TOTAL failures so far (monotonic, never reset) so
 * "before === 0" always identifies the due-date attempt — the caller
 * keys the Day-0 SMS off exactly that.
 *
 * Success outcomes are handled by the caller — they terminate the
 * ladder entirely (clear next_attempt_date, leave the counter as-is for
 * post-mortem readability; the row's `status` going to 'collected'
 * makes the counters moot).
 */
export function advanceLadderAfterFailure(input: LadderInput): LadderOutcome {
  const failuresAfter = input.consecutiveFailedAttemptsBefore + 1;
  const capCents      = computeFeeCapCents(input.originalBillRands);

  // Every failure earns a fee — clamped to remaining cap headroom (the cap
  // may bind below a full fee on a small bill, e.g. R150 bill → cap R75,
  // or the last fee before the R345 cap). Headroom < fee → the fee
  // shrinks to fit; headroom == 0 → no fee attaches (already at cap,
  // which the caller should not normally re-enter — see terminalStatus).
  const remainingHeadroom = Math.max(0, capCents - input.dunningFeesCentsBefore);
  const feeThisAttempt    = Math.min(DUNNING_FEE_CENTS, remainingHeadroom);

  const dunningFeesCentsAfter = input.dunningFeesCentsBefore + feeThisAttempt;
  const capReached            = dunningFeesCentsAfter >= capCents;

  const proposedNextAttemptDate = addDaysISO(input.today, WEEKLY_RETRY_GAP_DAYS);
  const nextInstalmentBoundaryHit =
    input.nextInstalmentDueDate !== null &&
    proposedNextAttemptDate >= input.nextInstalmentDueDate;

  let nextAttemptDate: string | null;
  let terminalStatus:  'defaulted' | null;
  if (capReached || nextInstalmentBoundaryHit) {
    nextAttemptDate = null;
    terminalStatus  = 'defaulted';
  } else {
    nextAttemptDate = proposedNextAttemptDate;
    terminalStatus  = null;
  }

  return {
    consecutiveFailedAttemptsAfter: failuresAfter,
    dunningFeesCentsAfter,
    feeAppliedThisAttempt:          feeThisAttempt,
    capReached,
    nextInstalmentBoundaryHit,
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
