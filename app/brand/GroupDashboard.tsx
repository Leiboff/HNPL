'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import BrandMonthlyChart from './BrandMonthlyChart';
import { computeRevenue, type RevenuePlan, type RevenuePractice, type RevenueProvider } from '@/lib/brand/revenue';
import { buildMonthlySeries, type PlanForTrend } from '@/lib/brand/monthlyRevenue';

// ─── Group dashboard (n>=2 brand experience) ─────────────────────────
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

export type BrandInfo = {
  id:      string;
  name:    string;
  logoUrl: string | null;
};

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
  brands:    BrandInfo[];
  branches:  BranchOption[];
  providers: ProviderOption[];
  /** Raw plans for the whole group; the client computes filtered
   *  revenue via computeRevenue + buildMonthlySeries. No collection
   *  fields — see server-side scoping guardrails. */
  plans:     Array<RevenuePlan & { created_at: string }>;
};

type RangeMonths = 3 | 6 | 12;

export default function GroupDashboard({
  brands,
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
      if (clampedProviderId && p.provider_id !== clampedProviderId) return false;
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

  // Strip follows the same filters. Each branch card recomputes from
  // filteredPlans — a branch with zero matching plans shows R0 but
  // stays in the strip (so a "no revenue" branch remains visible,
  // which is useful data).
  const perBranchNet = useMemo(() => {
    const m = new Map<string, { net: number; count: number }>();
    for (const row of summary.byPractice) m.set(row.id, { net: row.net, count: row.count });
    return m;
  }, [summary]);

  const sortedBranches = useMemo(() => {
    return [...branches].sort((a, b) => {
      const av = perBranchNet.get(a.id)?.net ?? 0;
      const bv = perBranchNet.get(b.id)?.net ?? 0;
      return bv - av;
    });
  }, [branches, perBranchNet]);

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 sm:py-10 space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: '#13294B' }}>My practices</h1>
          <p className="text-sm text-gray-500 mt-1">
            Revenue across every practice you run. Tap a practice to see per-doctor performance and manage its team.
          </p>
        </div>
      </header>

      {/* Quick actions (top) */}
      <section aria-label="Quick actions" className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="group-quick-actions-top">
        <Link
          href="/brand/new-practice"
          className="rounded-xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 hover:bg-gray-50"
          data-testid="group-add-practice"
        >
          <p className="text-xs uppercase tracking-widest text-gray-500">Add</p>
          <p className="text-sm font-semibold mt-1" style={{ color: '#13294B' }}>+ Add a practice</p>
        </Link>
        <Link
          href="/brand/group"
          className="rounded-xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 hover:bg-gray-50"
          data-testid="group-settings"
        >
          <p className="text-xs uppercase tracking-widest text-gray-500">Brand</p>
          <p className="text-sm font-semibold mt-1" style={{ color: '#13294B' }}>Settings &amp; logo</p>
        </Link>
      </section>

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

      {/* Practice performance strip */}
      <section aria-labelledby="branches-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="branches-heading" className="text-sm font-semibold" style={{ color: '#13294B' }}>
            Practice performance
          </h2>
          <span className="text-xs text-gray-500">
            {branches.length} {branches.length === 1 ? 'practice' : 'practices'}
          </span>
        </div>

        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="branch-strip">
          {sortedBranches.map((b) => {
            const bucket = perBranchNet.get(b.id) ?? { net: 0, count: 0 };
            const brand = brands.find((g) => g.id === b.groupId);
            return (
              <li key={b.id} className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{b.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {[b.suburb, b.city].filter(Boolean).join(', ') || '—'}
                    </p>
                    {brands.length > 1 && brand && (
                      <p className="text-[11px] text-gray-400 mt-0.5">{brand.name}</p>
                    )}
                  </div>
                  <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${
                    b.status === 'approved'  ? 'bg-green-100 text-green-700' :
                    b.status === 'pending'   ? 'bg-amber-100 text-amber-700' :
                    b.status === 'suspended' ? 'bg-red-100 text-red-700' :
                                               'bg-gray-100 text-gray-500'
                  }`}>
                    {b.status}
                  </span>
                </div>

                <p className="mt-3 text-2xl font-semibold" style={{ color: '#13294B' }} data-testid={`branch-value-${b.id}`}>
                  {formatRand(bucket.net)}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {bucket.count} active {bucket.count === 1 ? 'plan' : 'plans'} · net
                </p>

                {/* The branch page is the ONE way in for editing branch
                    details/team/banking. Till devices is a second,
                    parallel entry point — its own screen
                    (/practice/pos/devices), not a section of the branch
                    page — so it's a sibling link here rather than
                    something reached via "Open branch →". */}
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  <Link
                    href={`/brand/branch/${b.id}`}
                    className="font-semibold underline underline-offset-2"
                    style={{ color: '#13294B' }}
                    data-testid={`branch-drilldown-${b.id}`}
                  >
                    Open branch →
                  </Link>
                  <Link
                    href={`/practice/pos/devices?practiceId=${b.id}`}
                    className="font-semibold underline underline-offset-2"
                    style={{ color: '#13294B' }}
                    data-testid={`branch-till-devices-${b.id}`}
                  >
                    Till devices →
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

    </div>
  );
}
