// ─── Brand monthly revenue — pure aggregation ─────────────────────────
//
// Builds a 12-month rolling series of {gross, net} per calendar
// month. Companion to computeRevenue (which does the top-line and
// per-slice totals) — this is the trend view for the dashboard.
//
// Strictly uses the SAME status filter as computeRevenue
// (ACTIVE_FOR_REVENUE = {active, completed}). If the two ever drift,
// the hero total won't reconcile with its own trend. The existing
// practice-side MonthlyRevenueChart counts pending_acceptance too;
// we deliberately do NOT reuse that filter — brand analytics are
// stricter about what counts.

import { calculateFee } from '@/lib/finance';
import { isActiveForRevenue, type RevenuePlan } from '@/lib/brand/revenue';

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;

export type MonthPoint = {
  key:   string;         // 'YYYY-M'
  label: string;         // 'Jan' etc.
  year:  number;
  month: number;         // 1..12
  gross: number;
  net:   number;
};

// Plans on this API get their created_at as an ISO string (Supabase
// timestamptz shape). Callers must include created_at in the plans
// query — the base RevenuePlan on lib/brand/revenue doesn't include
// it (that helper is timeless), so we widen the input here.
export type PlanForTrend = RevenuePlan & { created_at: string };

// Reference-date-injected variant of `new Date()`. Kept for test
// callers that want a deterministic 12-month window; runtime callers
// just pass `new Date()`.
export function lastTwelveMonthsFrom(now: Date): Array<{ year: number; month: number; label: string }> {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1, label: MONTH_ABBR[d.getMonth()] };
  });
}

/**
 * Build a 12-month series of gross + net revenue. Only counts plans
 * whose status passes isActiveForRevenue and whose created_at falls
 * inside one of the last-12 months.
 *
 * feePercentByPractice: caller supplies a Map so we do the same
 * fee-lookup pattern as computeRevenue — a plan whose practice row
 * is unknown to us contributes net=gross (fail-safe, matches
 * computeRevenue's posture).
 */
export function buildMonthlySeries(
  plans:                PlanForTrend[],
  feePercentByPractice: Map<string, number>,
  now:                  Date = new Date(),
): MonthPoint[] {
  const months = lastTwelveMonthsFrom(now);
  return months.map(({ year, month, label }) => {
    let gross = 0;
    let net   = 0;
    for (const plan of plans) {
      if (!isActiveForRevenue(plan.status)) continue;
      const d = new Date(plan.created_at);
      if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
      const feePct  = feePercentByPractice.get(plan.practice_id) ?? 0;
      const { gross: g, net: n } = calculateFee(Number(plan.total_amount), feePct);
      gross += g;
      net   += n;
    }
    return {
      key: `${year}-${month}`,
      label,
      year,
      month,
      gross: round2(gross),
      net:   round2(net),
    };
  });
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
