/**
 * Pure helper to compute the patient-orders progress summary shown above
 * each plan's instalment list. Drives both the progress bar fill and the
 * caption ("1 of 3 paid · R3,232.00 remaining" / "Paid in full · 3 payments").
 */

export type PlanPaymentForProgress = {
  amount: number | string;       // accepts Supabase numeric strings too
  status: string;
};

export type PlanProgress = {
  totalPayments:    number;
  paidCount:        number;
  remainingAmount:  number;
  /** Percentage 0–100, integer. */
  percent:          number;
  /** True iff the plan is `completed`. Drives the "Paid in full" caption. */
  isPaidInFull:     boolean;
};

export function computePlanProgress(input: {
  status:   string;
  payments: PlanPaymentForProgress[];
}): PlanProgress {
  const totalPayments    = input.payments.length;
  const paidCount        = input.payments.filter((p) => p.status === 'collected').length;
  const remainingAmount  = input.payments
    .filter((p) => p.status !== 'collected')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const isPaidInFull     = input.status === 'completed';
  const percent          = totalPayments === 0
    ? 0
    : isPaidInFull
      ? 100
      : Math.round((paidCount / totalPayments) * 100);

  return { totalPayments, paidCount, remainingAmount, percent, isPaidInFull };
}
