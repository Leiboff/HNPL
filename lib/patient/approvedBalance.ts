// ─── Approved-balance computation — pure helper ────────────────────────
//
// Given a patient's approved credit limit and their currently-active
// plans, returns the "available" balance to display on the home
// dashboard's Approved Balance widget:
//
//   available = max(0, limit - Σ outstanding_principal_on_active_plans)
//
// Where the outstanding principal is the sum of `amount` on `payments`
// rows that are STILL owed:
//   status ∈ { scheduled, processing, failed, defaulted }
// A `defaulted` instalment IS still owed — the patient hasn't paid it —
// so it MUST keep consuming the limit. (It also freezes the patient out
// of new plans entirely; see lib/patient/freeze.ts. Excluding it here
// would perversely FREE the limit on default, which was the old bug.)
// Statuses NOT counted (already paid or forgiven):
//   collected — paid; retried — legacy; written_off — explicit
//   forgiveness (no debt).
//
// The widget is DISPLAY-ONLY:
//   • Renders nothing when limit is NULL (no fake placeholder, no "R0
//     available" — see the home dashboard page for the null-guard).
//   • This module never fetches; it just computes.

export type PaymentForBalance = {
  amount: number;
  status: string;
};

const OUTSTANDING_STATUSES = new Set(['scheduled', 'processing', 'failed', 'defaulted']);

/**
 * Sum the outstanding principal across every payment row on the
 * patient's active plans. Non-outstanding statuses (collected /
 * retried / written_off) don't count — the widget measures "what's
 * still yours to owe". A `defaulted` row IS still owed and counts.
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
