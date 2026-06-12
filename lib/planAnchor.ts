/**
 * Anchor-date helpers for the patient orders page. The "anchor" is the
 * date each plan card shows in its header AND the value cards are sorted
 * by within their tab:
 *
 *   • Pending / Current : `created_at` (rendered as "Started …")
 *   • Historic          : latest `collected_at` if any payment is
 *                         collected (rendered as "Completed …"), with a
 *                         fallback to `created_at` if no completion date
 *                         is available
 *
 * Pure functions so the sort and the header label stay in sync across the
 * UI and the tests.
 */

export type PlanAnchorInput = {
  created_at: string;
  payments:   Array<{ status: string; collected_at?: string | null }>;
};

export type OrdersTab = 'pending' | 'current' | 'historic';

/**
 * Latest `collected_at` across the plan's payments, or `null` when none
 * are collected. Lexical comparison works on ISO-8601 strings.
 */
export function planCompletionDate(plan: PlanAnchorInput): string | null {
  const dates = plan.payments
    .filter((p) => p.status === 'collected' && !!p.collected_at)
    .map((p) => p.collected_at as string);
  if (dates.length === 0) return null;
  return dates.reduce((latest, cur) => (cur > latest ? cur : latest));
}

/**
 * The ISO timestamp the card's header date label is based on AND the key
 * cards are sorted by within their tab.
 */
export function planAnchorDate(plan: PlanAnchorInput, tab: OrdersTab): string {
  if (tab === 'historic') {
    const completion = planCompletionDate(plan);
    if (completion) return completion;
  }
  return plan.created_at;
}

/**
 * Newest-first sort within a tab. Stable for ties: original order
 * preserved for identical anchor strings.
 */
export function sortPlansByAnchorDesc<T extends PlanAnchorInput>(
  plans: T[],
  tab: OrdersTab,
): T[] {
  // Annotate once so we don't recompute the anchor on every comparison.
  const decorated = plans.map((plan, idx) => ({
    plan,
    idx,
    anchor: planAnchorDate(plan, tab),
  }));
  decorated.sort((a, b) => {
    const cmp = b.anchor.localeCompare(a.anchor);
    return cmp !== 0 ? cmp : a.idx - b.idx;
  });
  return decorated.map((d) => d.plan);
}
