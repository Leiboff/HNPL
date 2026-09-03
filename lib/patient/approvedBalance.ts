// ─── Approved-balance computation — pure helper ────────────────────────
//
// What the home dashboard's Approved Balance widget shows:
//
//   limit      the patient's full standing limit — ALWAYS shown in full
//   committed  what active plans are holding against it
//   available  limit − committed, floored at zero
//
// ─── IT MUST AGREE WITH THE THING THAT ACTUALLY REFUSES ────────────────
//
// This module used to sum outstanding PAYMENT rows, which was a third
// definition of exposure sitting alongside `outstandingExposure` and the
// plpgsql in `claim_credit_for_plan`. Three definitions meant the number a
// patient was shown could differ from the number that refused them, which
// is a support ticket at best and a trust problem at worst.
//
// It now mirrors migration 0140's model exactly:
//
//   • a plan marked `full_value_exposure` holds its ENTIRE financed value
//     for its whole life — paying an instalment frees nothing, and the
//     whole amount is released in one step on completion
//   • a plan written before 0140 keeps the declining-balance arithmetic it
//     was accepted under
//   • a defaulted plan still holds its value under the new model; the debt
//     has not gone anywhere
//
// This is DISPLAY ONLY and still never fetches — the caller passes rows
// in. The authority is `patient_credit_exposure()` under the row lock.

export type PaymentForBalance = {
  amount: number | string;
  status: string;
  kind?: string | null;
  instalment_number?: number | null;
};

export type PlanForBalance = {
  status: string;
  full_value_exposure?: boolean | null;
  financed_amount?: number | string | null;
  total_amount?: number | string | null;
  excess_amount?: number | string | null;
  payments?: PaymentForBalance[] | null;
};

/** Statuses a legacy plan is counted in — unchanged from 0130. */
const LEGACY_LIVE = ['pending_first_payment', 'active'];

/** Under the full-value model a defaulted plan keeps holding its value. */
const FULL_VALUE_LIVE = [...LEGACY_LIVE, 'defaulted'];

/** Statuses that are NOT collected, i.e. still owed. */
const OUTSTANDING_STATUSES = new Set(['scheduled', 'processing', 'failed', 'defaulted']);

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Does this plan currently hold anything against the limit? */
function isLive(plan: PlanForBalance): boolean {
  return plan.full_value_exposure === true
    ? FULL_VALUE_LIVE.includes(plan.status)
    : LEGACY_LIVE.includes(plan.status);
}

/** What one plan holds. */
export function planExposure(plan: PlanForBalance): number {
  if (!isLive(plan)) return 0;

  if (plan.full_value_exposure === true) {
    // The full originated value, whatever has been paid so far.
    return round2(num(plan.financed_amount ?? plan.total_amount));
  }

  const instalments = (plan.payments ?? []).filter(
    (p) => (p.kind ?? 'instalment') === 'instalment' && OUTSTANDING_STATUSES.has(p.status),
  );
  if (instalments.length === 0) return 0;

  let total = instalments.reduce((sum, p) => sum + num(p.amount), 0);

  // The excess is the customer's own money in flight, not credit.
  if (instalments.some((p) => Number(p.instalment_number) === 1)) {
    total -= num(plan.excess_amount);
  }
  return round2(Math.max(0, total));
}

/** Total committed across every live plan. */
export function committedExposure(plans: PlanForBalance[]): number {
  return round2(plans.reduce((sum, p) => sum + planExposure(p), 0));
}

/**
 * Available headroom.
 *
 * Floored at zero so a patient whose limit was reduced on re-assessment
 * below their in-flight exposure never sees a negative number. Their
 * existing plans run to term regardless — a reduced limit does not claw
 * back a plan already written.
 */
export function availableBalance(limit: number, plans: PlanForBalance[]): number {
  return Math.max(0, round2(limit - committedExposure(plans)));
}

/**
 * The three figures the widget renders together.
 *
 * The full limit is always included: a first-time patient is shown their
 * real limit alongside the one-plan-at-a-time caveat, rather than being
 * shown a reduced figure that quietly hides what they qualified for.
 */
export function balanceSummary(limit: number, plans: PlanForBalance[]): {
  limit: number;
  committed: number;
  available: number;
} {
  const committed = committedExposure(plans);
  return { limit, committed, available: Math.max(0, round2(limit - committed)) };
}
