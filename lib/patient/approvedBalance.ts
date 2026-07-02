// ─── Approved-balance computation — pure helper ────────────────────────
//
// Given a patient's approved credit limit and their currently-active
// plans, returns the "available" balance to display on the home
// dashboard's Approved Balance widget:
//
//   available = max(0, limit - Σ outstanding_principal_on_active_plans)
//
// Where the outstanding principal on an active plan is the sum of
// `amount` on `payments` rows that are STILL owed:
//   status ∈ { scheduled, processing, failed }
// Statuses NOT counted (already collected or terminal):
//   collected, retried, written_off, defaulted
//   (defaulted is "we've given up chasing" — from the patient's
//    perspective they haven't paid, but for CREDIT-LIMIT accounting
//    the balance stops accruing at write-off / default; the outstanding
//    is what's still owed on ACTIVE plans, not a lifetime tally.)
//
// The widget is DISPLAY-ONLY:
//   • Renders nothing when limit is NULL (no fake placeholder, no "R0
//     available" — see the home dashboard page for the null-guard).
//   • This module never fetches; it just computes.

export type PaymentForBalance = {
  amount: number;
  status: string;
};

const OUTSTANDING_STATUSES = new Set(['scheduled', 'processing', 'failed']);

/**
 * Sum the outstanding principal across every payment row on the
 * patient's active plans. Non-outstanding statuses (collected /
 * retried / written_off / defaulted) don't count — the widget
 * measures "what's still yours to owe on active plans".
 *
 * Pass ONLY the payments belonging to active plans (the caller
 * filters upstream) — this function trusts its input and doesn't
 * re-check plan status.
 */
export function outstandingPrincipal(payments: PaymentForBalance[]): number {
  let total = 0;
  for (const p of payments) {
    if (OUTSTANDING_STATUSES.has(p.status)) {
      total += Number(p.amount) || 0;
    }
  }
  return round2(total);
}

/**
 * Approved balance available to spend on new bills.
 *   available = max(0, limit - outstanding)
 * Floored at zero so a patient who has slightly overshot never sees
 * a negative number.
 */
export function availableBalance(
  limit:       number,
  payments:    PaymentForBalance[],
): number {
  const outstanding = outstandingPrincipal(payments);
  return Math.max(0, round2(limit - outstanding));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
