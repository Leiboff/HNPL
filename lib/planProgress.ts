/**
 * Pure helper to compute the patient-orders progress summary shown above
 * each plan's instalment list. Drives both the progress bar fill and the
 * caption ("1 of 3 paid · R3,232.00 remaining" / "Paid in full · 3 payments").
 *
 * Settlement rows (kind='settlement', added by migration 0058) are
 * EXCLUDED defensively here even though the call site already filters
 * them — a settlement row's amount is the sum of the instalments it
 * covers, which would otherwise double-count the outstanding and
 * inflate totalPayments. Filtering in one place per concern means a
 * future caller that forgets the filter still gets the right answer.
 */

export type PlanPaymentForProgress = {
  amount: number | string;       // accepts Supabase numeric strings too
  status: string;
  /** Optional — when absent, treated as 'instalment'. */
  kind?: string;
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
  const instalments      = input.payments.filter((p) => (p.kind ?? 'instalment') !== 'settlement');
  const totalPayments    = instalments.length;
  const paidCount        = instalments.filter((p) => p.status === 'collected').length;
  const remainingAmount  = instalments
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
