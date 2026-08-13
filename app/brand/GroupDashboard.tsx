'use client';

import { useMemo, useState } from 'react';
import BrandMonthlyChart from './BrandMonthlyChart';
import { computeRevenue, type RevenuePlan, type RevenuePractice, type RevenueProvider } from '@/lib/brand/revenue';
import { buildMonthlySeries, type PlanForTrend } from '@/lib/brand/monthlyRevenue';

// ─── The Overview tab's REVENUE section (n>=2 brand experience) ───────
//
// WHAT THIS COMPONENT IS NOW
// ──────────────────────────
// It used to BE the whole brand surface: page header, quick actions,
// revenue hero, filters, trend, by-doctor, and a per-practice
// performance strip. The brand portal restructure split those apart:
//
//   page header + brand name      → ./BrandShell (with the nav)
//   quick actions                 → ./BrandQuickActions
//   practice performance strip    → RETIRED. Everything on it now has a
//                                   better home, and it was the one piece
//                                   that made Overview a second, richer
//                                   copy of a practice dashboard:
//                                     · name + next payout + plan count
//                                       + doorway → ./BrandPayoutBlock,
//                                       whose rows are the same practices
//                                       carrying money instead of a
//                                       filtered revenue figure
//                                     · approval status + location
//                                       → /brand/practices, the admin
//                                       table built to be scanned
//                                     · per-practice revenue net
//                                       → /brand/revenue's "By practice",
//                                       which already had it
//                                     · the Till devices link
//                                       → /brand/practices' till column
//
// What is left here is the revenue ANALYSIS, and it keeps every figure
// it had: the group net, the three filters, the 12-month trend, and the
// ranked by-doctor list.
//
// Net-only. The whole brand surface renders the practice's own take
// after BetterNow's commission. Gross is a book-keeping detail on the
// server but never surfaced on this screen. The subtitle labels the
// figure "net of commission" once, no toggle.
//
// Filters (client-state; not URL-persisted — the dropdown options are
// generated from the caller's own group data, so filter IDs are
// inherently clamped to the caller's own scope):
//   • practice  — one branch, or all
//   • doctor    — one provider, or all
//   • range     — 3 / 6 / 12 months (last-N windows)
// Filters combine (AND). The hero, trend chart, AND performance strip
// all follow the same filter state — one consistent read across the
// whole page.

function formatRand(v: number): string {
  const [integer, decimal] = v.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export type BranchOption = {
  id:       string;
  name:     string;
  status:   string;
  suburb:   string | null;
  city:     string | null;
  groupId:  string;
  feePct:   number;
};

export type ProviderOption = {
  id:       string;   // user_id
  fullName: string;
};

export type GroupDashboardProps = {
  branches:  BranchOption[];
  providers: ProviderOption[];
  /** Raw plans for the whole group; the client computes filtered
   *  revenue via computeRevenue + buildMonthlySeries. No collection
   *  fields — see server-side scoping guardrails. */
  plans:     Array<RevenuePlan & { created_at: string }>;
};

type RangeMonths = 3 | 6 | 12;

export default function GroupDashboard({
  branches,
  providers,
  plans,
}: GroupDashboardProps) {
  const [practiceFilter, setPracticeFilter] = useState<string>('');   // '' = all
  const [providerFilter, setProviderFilter] = useState<string>('');
  const [rangeMonths,    setRangeMonths]    = useState<RangeMonths>(12);

  // Filter clamp — dropdown values are read from the caller's own
  // lists, but if a stale value ever ended up in state we defensively
  // fall back to "all" rather than allowing an unmatched ID through.
  const validPracticeIds = useMemo(() => new Set(branches.map((b) => b.id)), [branches]);
  const validProviderIds = useMemo(() => new Set(providers.map((p) => p.id)), [providers]);
  const clampedPracticeId = practiceFilter && validPracticeIds.has(practiceFilter) ? practiceFilter : null;
  const clampedProviderId = providerFilter && validProviderIds.has(providerFilter) ? providerFilter : null;

  // Date window — plans.created_at >= (now − rangeMonths months). The
  // MonthPoint series still renders 12 slots (buildMonthlySeries
  // always produces 12) but plans outside the window are excluded from
  // BOTH the hero total and the chart, so the earlier months read as
  // zero for 3-month/6-month selections. This is intentional — the
  // strip stays a 12-month cumulative comparison unless the range
  // narrows.
  const cutoff = useMemo(() => {
    if (rangeMonths === 12) return null;   // no cutoff for the default view
    const d = new Date();
    d.setMonth(d.getMonth() - rangeMonths);
    d.setDate(1); d.setHours(0, 0, 0, 0);
    return d;
  }, [rangeMonths]);

  const filteredPlans = useMemo(() => {
    return plans.filter((p) => {
      if (clampedPracticeId && p.practice_id !== clampedPracticeId) return false;
      if (clampedProviderId && p.provider_member_id !== clampedProviderId) return false;
      if (cutoff) {
        const d = new Date(p.created_at);
        if (d < cutoff) return false;
      }
      return true;
    });
  }, [plans, clampedPracticeId, clampedProviderId, cutoff]);

  // Pure helpers — same as the server's aggregation, just applied to
  // the filtered subset.
  const feeByPractice = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of branches) m.set(b.id, b.feePct);
    return m;
  }, [branches]);

  const revenuePractices: RevenuePractice[] = useMemo(
    () => branches.map((b) => ({ id: b.id, name: b.name, fee_percent: b.feePct })),
    [branches],
  );
  const revenueProviders: RevenueProvider[] = useMemo(
    () => providers.map((p) => ({ id: p.id, fullName: p.fullName })),
    [providers],
  );

  const summary = useMemo(
    () => computeRevenue(filteredPlans, revenuePractices, revenueProviders, {}),
    [filteredPlans, revenuePractices, revenueProviders],
  );

  const monthly = useMemo(
    () => buildMonthlySeries(filteredPlans as PlanForTrend[], feeByPractice),
    [filteredPlans, feeByPractice],
  );

  // ── By doctor ────────────────────────────────────────────────────────
  //
  // This ranked list used to live ONLY on /brand/branch/[practiceId]
  // (BranchPerformance's "By doctor" block). That page now pivots into
  // the practice's own dashboard, so the list would have been lost
  // outright: /brand had a doctor FILTER but never rendered a per-doctor
  // breakdown, and the practice dashboard doesn't either — you could
  // read one doctor's total at a time but never see them ranked.
  //
  // It belongs here, where the rest of the rollup now lives, and it costs
  // nothing to compute: computeRevenue has always returned byProvider,
  // and it was simply unused on this screen. Following the same filter
  // state as the hero and trend means the per-BRANCH view the branch page
  // used to give is reproduced by setting the Practice filter — with
  // cross-branch ranking available as well, which the branch page could
  // not do.
  const sortedDoctors = useMemo(
    () => [...summary.byProvider].sort((a, b) => b.net - a.net),
    [summary],
  );

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold" style={{ color: '#13294B' }}>Revenue</h2>
        <p className="text-sm text-gray-500 mt-1">
          Revenue across every practice you run. Per-doctor performance is below; tap a practice
          in the payouts list above to open its own dashboard.
        </p>
      </header>

      {/* Hero — net total */}
      <section
        aria-labelledby="group-revenue-hero"
        className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm p-6"
      >
        <p
          id="group-revenue-hero"
          className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: '#13294B', opacity: 0.55 }}
        >
          Group revenue — active plans
        </p>
        <p className="text-3xl font-semibold mt-2" style={{ color: '#13294B' }} data-testid="group-hero-total">
          {formatRand(summary.totalNet)}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {summary.totalCount} active {summary.totalCount === 1 ? 'plan' : 'plans'} · net of commission
        </p>
      </section>

      {/* Filters */}
      <section
        aria-labelledby="group-filters"
        className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm p-4"
        data-testid="group-filters"
      >
        <p id="group-filters" className="sr-only">Filters</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">Practice</label>
            <select
              value={practiceFilter}
              onChange={(e) => setPracticeFilter(e.target.value)}
              data-testid="group-filter-practice"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900"
            >
              <option value="">All practices</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">Doctor</label>
            <select
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              data-testid="group-filter-provider"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900"
            >
              <option value="">All doctors</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.fullName}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">Range</label>
            <div className="inline-flex rounded-lg border border-gray-200 p-0.5" role="tablist" aria-label="Date range">
              {([3, 6, 12] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={rangeMonths === m}
                  onClick={() => setRangeMonths(m)}
                  data-testid={`group-filter-range-${m}m`}
                  className={`px-3 py-1 text-xs font-semibold rounded-md ${
                    rangeMonths === m ? 'text-white' : 'text-gray-500'
                  }`}
                  style={rangeMonths === m
                    ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }
                    : {}}
                >
                  {m}m
                </button>
              ))}
            </div>
          </div>

          {(clampedPracticeId || clampedProviderId || rangeMonths !== 12) && (
            <button
              type="button"
              onClick={() => { setPracticeFilter(''); setProviderFilter(''); setRangeMonths(12); }}
              data-testid="group-filter-clear"
              className="text-xs text-gray-500 hover:underline ml-auto"
            >
              Clear all
            </button>
          )}
        </div>
      </section>

      {/* Trend */}
      <BrandMonthlyChart points={monthly} />

      {/* By doctor — see sortedDoctors above for why this lives here now. */}
      <section
        aria-labelledby="group-doctors-heading"
        className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm p-6"
      >
        <h2
          id="group-doctors-heading"
          className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: '#13294B', opacity: 0.55 }}
        >
          By doctor
        </h2>
        {sortedDoctors.length === 0 ? (
          <p className="text-xs text-gray-500 mt-3" data-testid="group-doctor-breakdown-empty">
            No plans attributed to a doctor yet.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 mt-3" data-testid="group-doctor-breakdown">
            {sortedDoctors.map((d) => (
              <li key={d.id} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{d.label}</p>
                  <p className="text-[11px] text-gray-500">
                    {d.count} active {d.count === 1 ? 'plan' : 'plans'}
                  </p>
                </div>
                <p className="text-sm font-semibold whitespace-nowrap" style={{ color: '#13294B' }}>
                  {formatRand(d.net)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  );
}
