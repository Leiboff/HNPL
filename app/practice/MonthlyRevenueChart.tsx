'use client';

import { useMemo } from 'react';
import BrandMonthlyChart from '@/app/brand/BrandMonthlyChart';
import { buildMonthlySeries, type PlanForTrend } from '@/lib/brand/monthlyRevenue';

// ─── Practice dashboard — monthly revenue chart ───────────────────────
//
// Thin adapter around the shared brand primitives:
//   • buildMonthlySeries (lib/brand/monthlyRevenue) does the
//     aggregation, filtered by isActiveForRevenue = {active, completed}
//     — the SAME predicate the brand view uses. If a plan is
//     pending_acceptance, it contributes zero here (was inflating the
//     old dashboard series and disagreeing with the brand view of the
//     same branch).
//   • BrandMonthlyChart (app/brand/BrandMonthlyChart) is a rendering-
//     only SVG. No status logic lives in the chart component.
//
// The dashboard has always presented NET; we keep that. Gross↔net
// toggling lives on the brand-side surfaces (group hero, branch
// hero); this per-practice screen is single-mode.
//
// Fee lookup is a single-entry Map because every plan on this page
// belongs to one practice already (server scoped by practiceId). We
// tag those plans with a synthetic `practice_id: SELF` so the shared
// helper's per-practice fee lookup works without threading the real
// practice id all the way through.

const SELF = '__self__';

/**
 * The five fields this chart actually reads — not the full PlanSummary it used
 * to demand.
 *
 * It moved from the dashboard (where a fat plans query was already in hand) to
 * /practice/payouts, which has no other use for plans. Asking that page for
 * patient names, provider embeds, payouts and invitations to draw a monthly
 * trend would have made it copy the dashboard's projection for nothing — and
 * made that projection a third thing to keep in step. PlanSummary still
 * satisfies this shape structurally, so any caller that has one can pass it.
 */
export type PlanForMonthlyChart = {
  id:                 string;
  provider_member_id: string | null;
  total_amount:       number | string;
  status:             string;
  created_at:         string;
};

type Props = {
  plans:      PlanForMonthlyChart[];
  feePercent: number;
};

export default function MonthlyRevenueChart({ plans, feePercent }: Props) {
  const points = useMemo(() => {
    const feeByPractice = new Map<string, number>([[SELF, feePercent]]);
    const adapted: PlanForTrend[] = plans.map((p) => ({
      id:           p.id,
      practice_id:  SELF,
      provider_member_id: p.provider_member_id,
      total_amount: Number(p.total_amount),
      status:       p.status,
      created_at:   p.created_at,
    }));
    return buildMonthlySeries(adapted, feeByPractice);
  }, [plans, feePercent]);

  return <BrandMonthlyChart points={points} mode="net" />;
}
