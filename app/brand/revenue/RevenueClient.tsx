'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { RevenueSummary } from '@/lib/brand/revenue';

// ─── Revenue dashboard — client surface ────────────────────────────────
//
// Gross⇄net toggle (client-side; the server already computed both).
// Practice + doctor filters are URL params (so links are shareable
// and the server reruns the aggregation with the right scope).
//
// What is intentionally NOT here: collection-progress (settled-so-far,
// remaining instalments, paystack state). The provider sees activated-
// plan gross/net only; collection is BetterNow's float position.

type Props = {
  summary:            RevenueSummary;
  practices:          Array<{ id: string; name: string }>;
  providers:          Array<{ id: string; fullName: string }>;
  selectedPracticeId: string | null;
  selectedProviderId: string | null;
};

function rand(v: number): string {
  // Compact ZAR formatter — same posture as MonthlyRevenueChart's
  // shortAmt but a full string here because the dashboard headline
  // is the prominent figure.
  return v.toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 });
}

export default function RevenueClient({
  summary,
  practices,
  providers,
  selectedPracticeId,
  selectedProviderId,
}: Props) {
  const [view, setView] = useState<'gross' | 'net'>('gross');
  const router       = useRouter();
  const searchParams = useSearchParams();

  function setFilter(key: 'practice' | 'provider', value: string | null) {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (value) params.set(key, value);
    else       params.delete(key);
    router.push(`/brand/revenue?${params.toString()}`);
  }

  const headlineFigure = view === 'gross' ? summary.totalGross : summary.totalNet;

  return (
    <div className="space-y-6">
      {/* ── Filters + toggle ─────────────────────────────────────── */}
      <div className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-5 py-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Filters</p>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-600 w-20 shrink-0">Practice</label>
            <select
              value={selectedPracticeId ?? ''}
              onChange={(e) => setFilter('practice', e.target.value || null)}
              data-testid="filter-practice"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900"
            >
              <option value="">All practices</option>
              {practices.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-600 w-20 shrink-0">Doctor</label>
            <select
              value={selectedProviderId ?? ''}
              onChange={(e) => setFilter('provider', e.target.value || null)}
              data-testid="filter-provider"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900"
            >
              <option value="">All doctors</option>
              {providers.map((d) => (
                <option key={d.id} value={d.id}>{d.fullName}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ── Headline figure with gross/net toggle ────────────────── */}
      <div className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-5 py-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            {view === 'gross' ? 'Gross billed (active plans)' : 'Net to provider (after commission)'}
          </p>
          <div className="inline-flex rounded-full border border-gray-200 bg-gray-50 p-1 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setView('gross')}
              data-testid="revenue-toggle-gross"
              className={`px-3 py-1 rounded-full transition ${view === 'gross' ? 'bg-white shadow-sm text-[#13294B]' : 'text-gray-500'}`}
            >
              Gross
            </button>
            <button
              type="button"
              onClick={() => setView('net')}
              data-testid="revenue-toggle-net"
              className={`px-3 py-1 rounded-full transition ${view === 'net' ? 'bg-white shadow-sm text-[#13294B]' : 'text-gray-500'}`}
            >
              Net
            </button>
          </div>
        </div>
        <p className="mt-2 text-3xl font-semibold" style={{ color: '#13294B' }} data-testid="revenue-headline">
          {rand(headlineFigure)}
        </p>
        <p className="mt-1 text-xs text-gray-500">
          {summary.totalCount} active plan{summary.totalCount === 1 ? '' : 's'}.
          {view === 'gross'
            ? ' Toggle to Net to see what you receive after BetterNow’s commission.'
            : ' Net = gross − commission per the practice’s fee.'}
        </p>
      </div>

      {/* ── Breakdown: by practice ───────────────────────────────── */}
      <BreakdownTable
        title="By practice"
        rows={summary.byPractice}
        view={view}
        emptyMessage="No active plans match the current filters."
        testIdPrefix="row-practice"
      />

      {/* ── Breakdown: by doctor ─────────────────────────────────── */}
      <BreakdownTable
        title="By doctor"
        rows={summary.byProvider}
        view={view}
        emptyMessage="No active plans attributed to a doctor under the current filters."
        testIdPrefix="row-provider"
      />
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  view,
  emptyMessage,
  testIdPrefix,
}: {
  title:        string;
  rows:         RevenueSummary['byPractice'];
  view:         'gross' | 'net';
  emptyMessage: string;
  testIdPrefix: string;
}) {
  return (
    <section className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm">
      <header className="px-5 py-3 border-b border-gray-100">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">{title}</p>
      </header>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-gray-500">{emptyMessage}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map((r) => (
            <li
              key={r.id}
              data-testid={`${testIdPrefix}-${r.id}`}
              className="flex items-center justify-between gap-3 px-5 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{r.label}</p>
                <p className="text-xs text-gray-500">
                  {r.count} active plan{r.count === 1 ? '' : 's'}
                </p>
              </div>
              <p className="text-sm font-semibold" style={{ color: '#13294B' }}>
                {rand(view === 'gross' ? r.gross : r.net)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
