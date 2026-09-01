import { clampSalaryDateForMonth } from './salaryDates';

export function splitInstalments(
  totalAmountRands: number,
  planType: 2 | 3,
): number[] {
  const totalCents = Math.round(totalAmountRands * 100);
  const baseCents = Math.floor(totalCents / planType);
  const remainderCents = totalCents - baseCents * planType;

  const instalments = Array.from({ length: planType }, (_, i) =>
    i === 0 ? baseCents + remainderCents : baseCents,
  );

  return instalments.map((cents) => Math.round(cents) / 100);
}

export function calculateFee(
  grossAmountRands: number,
  feePercent: number,
): { gross: number; fee: number; net: number } {
  const grossCents = Math.round(grossAmountRands * 100);
  const feeCents = Math.round(grossCents * (feePercent / 100));
  const netCents = grossCents - feeCents;

  return {
    gross: grossCents / 100,
    fee: feeCents / 100,
    net: netCents / 100,
  };
}

function nextSalaryDate(after: Date, salaryDay: number, bufferDays: number): Date {
  // All arithmetic in UTC — 'after' is always a UTC-midnight Date here.
  const earliest = new Date(Date.UTC(
    after.getUTCFullYear(),
    after.getUTCMonth(),
    after.getUTCDate() + bufferDays,   // JS handles month overflow automatically
  ));

  const candidate = clampSalaryDateForMonth(after.getUTCFullYear(), after.getUTCMonth(), salaryDay);

  if (candidate >= earliest) {
    return candidate;
  }

  // Move to the following month.
  const nextMonth = after.getUTCMonth() === 11 ? 0 : after.getUTCMonth() + 1;
  const nextYear  = after.getUTCMonth() === 11 ? after.getUTCFullYear() + 1 : after.getUTCFullYear();
  return clampSalaryDateForMonth(nextYear, nextMonth, salaryDay);
}

export function calculatePaymentDates(
  startDate: Date,
  salaryDay: number,
  planType: 2 | 3,
  bufferDays = 5,
): Date[] {
  // Normalize to UTC midnight of startDate's UTC calendar date. Without this,
  // a mid-day live timestamp serialises correctly by luck; a local-midnight Date
  // on UTC+2 would shift back one day via .toISOString().
  const payment1 = new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  ));

  const payment2 = nextSalaryDate(payment1, salaryDay, bufferDays);

  if (planType === 2) {
    return [payment1, payment2];
  }

  // Payment 3: hard-advance to the month after payment2's UTC month.
  const payment3Month = payment2.getUTCMonth() === 11 ? 0 : payment2.getUTCMonth() + 1;
  const payment3Year  = payment2.getUTCMonth() === 11 ? payment2.getUTCFullYear() + 1 : payment2.getUTCFullYear();
  const payment3      = clampSalaryDateForMonth(payment3Year, payment3Month, salaryDay);

  return [payment1, payment2, payment3];
}

// ─── Bills above the customer's allowance ────────────────────────────────
//
// THE MODEL (product decision, 2026-09-02; audit A-05)
//
// HNPL finances up to the customer's approved allowance and no more. A bill
// ABOVE it is not refused — it is restructured, and the part HNPL is not
// financing is collected on the first instalment, from the customer's card,
// before the plan activates.
//
//   allowance R15,000 · bill R30,000 · 3 instalments
//     financed = R15,000  →  R5,000 × 3
//     excess   = R15,000  →  all of it onto instalment 1
//     schedule = R20,000 / R5,000 / R5,000
//
// So HNPL's exposure after instalment 1 clears is bounded by the allowance,
// whatever the bill is, and the practice is still paid 94% of the GROSS —
// `calculateFee` is untouched and the fee arithmetic does not change.
//
// ─── WHY THE EXCESS GOES ENTIRELY ON INSTALMENT 1 ──────────────────────
//
// Because instalment 1 is the one HNPL watches clear before it commits its
// own capital (activateFirstInstalment creates the payout on that event, and
// only that event). Money HNPL is not lending has to be collected at the
// moment the risk decision is made, not spread across instalments it would
// then be carrying. Spreading it would make the allowance meaningless: the
// customer would owe more than their limit for two more months.
//
// ─── WHAT THIS FUNCTION DELIBERATELY DOES NOT DECIDE ───────────────────
//
// Whether the customer HAS an allowance, and how much of it is already
// spent. That is `claim_credit_for_plan` (migration 0130), which reads the
// limit under a row lock and passes what is left in here as `availableRands`.
// This function is pure arithmetic on numbers it is given — same contract as
// every other function in this file, and the reason it is testable against
// known answers.
//
// A ZERO or NEGATIVE `availableRands` is a legal input and produces
// `financed: 0` with the whole bill on instalment 1: a customer with no
// allowance left is paying by card, not taking a plan. The CALLER decides
// whether that is an acceptable outcome to offer — see MIN_FINANCED_RANDS
// below and the refusal in 0130 — because "pay the whole thing now" is a
// product decision, not an arithmetic one.

/**
 * The smallest financed portion worth calling a payment plan.
 *
 * Below this the schedule degenerates: instalments 2 and 3 round to a few
 * rand or to zero, the customer is charged almost everything up front, and
 * the plan is a card payment wearing a plan's clothes. 0130 refuses rather
 * than writing one.
 *
 * R300 rather than a round R500 because it has to divide sensibly by 3 —
 * R100 instalments are small but not absurd.
 */
export const MIN_FINANCED_RANDS = 300;

export type InstalmentSplit = {
  /** Per-instalment amounts in rands, index 0 first. Sums to the bill total. */
  instalments: number[];
  /** The part HNPL is lending, in rands. Never more than the allowance. */
  financed: number;
  /** The part collected up front on instalment 1, in rands. Zero when the bill fits. */
  excess: number;
};

/**
 * Split a bill into `planType` instalments, financing at most
 * `availableRands` and loading any excess onto the first instalment.
 *
 * Integer cents throughout, like everything else here. The financed portion
 * is split by the same rule `splitInstalments` uses — remainder onto the
 * first instalment — so a bill that fits inside the allowance produces a
 * schedule IDENTICAL to the one it produced before this function existed.
 * That equivalence is asserted in finance.test.ts and is what makes this
 * safe to route every caller through.
 */
export function splitInstalmentsWithExcess(
  totalAmountRands: number,
  planType: 2 | 3,
  availableRands: number,
): InstalmentSplit {
  const totalCents = Math.round(totalAmountRands * 100);

  // Clamp at both ends: a negative allowance finances nothing, and an
  // allowance larger than the bill finances the bill.
  const availableCents = Math.max(0, Math.round(availableRands * 100));
  const financedCents  = Math.min(totalCents, availableCents);
  const excessCents    = totalCents - financedCents;

  const baseCents      = Math.floor(financedCents / planType);
  const remainderCents = financedCents - baseCents * planType;

  const cents = Array.from({ length: planType }, (_, i) =>
    i === 0 ? baseCents + remainderCents + excessCents : baseCents,
  );

  return {
    instalments: cents.map((c) => c / 100),
    financed:    financedCents / 100,
    excess:      excessCents / 100,
  };
}
