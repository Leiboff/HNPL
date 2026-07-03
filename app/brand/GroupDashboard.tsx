'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { MonthPoint } from '@/lib/brand/monthlyRevenue';
import BrandMonthlyChart from './BrandMonthlyChart';

// ─── Group dashboard (n>=2 brand experience) ─────────────────────────
//
// Replaces the tile menu. One page, three sections, one gross/net
// toggle that flips every figure at once:
//   1. Hero — group revenue total in the selected mode.
//   2. Trend — 12-month bar chart in the selected mode.
//   3. Practice performance strip — one card per branch with revenue
//      in the selected mode, active-plan count, and a delta vs
//      previous month (cheap-to-compute from the same monthly data;
//      shown only when previous-month data exists). Sorted by
//      selected-mode revenue DESC.
//
// The gross/net toggle is client state — it does not survive a page
// refresh. That's intentional; the whole page renders in <150ms from
// pre-aggregated inputs, so no URL param is needed.

function formatRand(v: number): string {
  const [integer, decimal] = v.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export type BrandInfo = {
  id:      string;
  name:    string;
  logoUrl: string | null;
};

export type BranchInfo = {
  id:               string;
  name:             string;
  status:           string;
  suburb:           string | null;
  city:             string | null;
  groupId:          string;
  gross:            number;   // this branch's total gross (ACTIVE_FOR_REVENUE only)
  net:              number;   // this branch's total net
  activePlanCount:  number;
  monthly:          MonthPoint[];  // this branch's own 12-month series
};

export type GroupDashboardProps = {
  brands:      BrandInfo[];
  branches:    BranchInfo[];
  totalGross:  number;
  totalNet:    number;
  totalActive: number;
  monthly:     MonthPoint[];  // group-level 12-month series (sum of branches')
};

export default function GroupDashboard({
  brands,
  branches,
  totalGross,
  totalNet,
  totalActive,
  monthly,
}: GroupDashboardProps) {
  const [mode, setMode] = useState<'gross' | 'net'>('gross');

  const totalForMode = mode === 'gross' ? totalGross : totalNet;

  // Sort branches by selected-mode revenue DESC. Recompute on mode
  // flip so the strip stays intuitive.
  const sortedBranches = useMemo(() => {
    return [...branches].sort((a, b) => {
      const av = mode === 'gross' ? a.gross : a.net;
      const bv = mode === 'gross' ? b.gross : b.net;
      return bv - av;
    });
  }, [branches, mode]);

  // Cheap delta: compare the two most-recent months of each branch's
  // own monthly series. `monthly.length` is always 12; the last two
  // entries are current month and previous month.
  function deltaPct(points: MonthPoint[], m: 'gross' | 'net'): number | null {
    if (points.length < 2) return null;
    const curr = m === 'gross' ? points[11].gross : points[11].net;
    const prev = m === 'gross' ? points[10].gross : points[10].net;
    if (prev <= 0) return null;
    return ((curr - prev) / prev) * 100;
  }

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

      {/* Hero — total revenue + gross/net toggle */}
      <section
        aria-labelledby="group-revenue-hero"
        className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p
              id="group-revenue-hero"
              className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: '#13294B', opacity: 0.55 }}
            >
              Group revenue — active plans
            </p>
            <p className="text-3xl font-semibold mt-2" style={{ color: '#13294B' }} data-testid="group-hero-total">
              {formatRand(totalForMode)}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {totalActive} active {totalActive === 1 ? 'plan' : 'plans'} across your group.
            </p>
          </div>
          <div className="inline-flex rounded-lg border border-gray-200 p-0.5" role="tablist" aria-label="Gross or net">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'gross'}
              onClick={() => setMode('gross')}
              data-testid="group-mode-gross"
              className={`px-3 py-1 text-xs font-semibold rounded-md ${
                mode === 'gross' ? 'text-white' : 'text-gray-500'
              }`}
              style={mode === 'gross'
                ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }
                : {}}
            >
              Gross
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'net'}
              onClick={() => setMode('net')}
              data-testid="group-mode-net"
              className={`px-3 py-1 text-xs font-semibold rounded-md ${
                mode === 'net' ? 'text-white' : 'text-gray-500'
              }`}
              style={mode === 'net'
                ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }
                : {}}
            >
              Net
            </button>
          </div>
        </div>
      </section>

      {/* Trend — 12-month chart in the selected mode */}
      <BrandMonthlyChart points={monthly} mode={mode} />

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
            const value = mode === 'gross' ? b.gross : b.net;
            const delta = deltaPct(b.monthly, mode);
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

                <div className="mt-3 flex items-baseline gap-2">
                  <p className="text-2xl font-semibold" style={{ color: '#13294B' }} data-testid={`branch-value-${b.id}`}>
                    {formatRand(value)}
                  </p>
                  {delta !== null && (
                    <span className={`text-xs font-semibold ${
                      delta > 0 ? 'text-emerald-700' : delta < 0 ? 'text-red-700' : 'text-gray-500'
                    }`}>
                      {delta > 0 ? '↑' : delta < 0 ? '↓' : ''} {Math.abs(delta).toFixed(0)}%
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {b.activePlanCount} active {b.activePlanCount === 1 ? 'plan' : 'plans'} · {mode === 'gross' ? 'gross' : 'net'}
                </p>

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
                    href={`/practice?practiceId=${b.id}`}
                    className="text-gray-500 hover:underline"
                  >
                    Practice dashboard
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Quick actions — secondary affordances (add practice + brand settings) */}
      <section aria-label="Quick actions" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
    </div>
  );
}
