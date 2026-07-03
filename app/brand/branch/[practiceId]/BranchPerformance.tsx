'use client';

import { useMemo, useState } from 'react';
import BrandMonthlyChart from '@/app/brand/BrandMonthlyChart';
import type { MonthPoint } from '@/lib/brand/monthlyRevenue';

// ─── Branch-detail: Performance section ────────────────────────────────
//
// This branch's own revenue view. Gross/net toggle carried locally
// (mirrors the group dashboard's toggle so a brand-admin flipping
// mode there and drilling into a branch sees consistent shape — but
// each screen owns its own toggle state, no cross-screen URL wiring).
//
// Per-doctor breakdown reuses computeRevenue's byProvider rows,
// pre-computed server-side and scoped to this practice. Rows are
// sorted DESC by selected-mode revenue.

function formatRand(v: number): string {
  const [integer, decimal] = v.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export type DoctorRevenueRow = {
  providerId: string;
  fullName:   string;
  count:      number;
  gross:      number;
  net:        number;
};

export type BranchPerformanceProps = {
  branchName:       string;
  totalGross:       number;
  totalNet:         number;
  activePlanCount:  number;
  monthly:          MonthPoint[];
  doctorRows:       DoctorRevenueRow[];
};

export default function BranchPerformance({
  branchName,
  totalGross,
  totalNet,
  activePlanCount,
  monthly,
  doctorRows,
}: BranchPerformanceProps) {
  const [mode, setMode] = useState<'gross' | 'net'>('gross');
  const totalForMode = mode === 'gross' ? totalGross : totalNet;

  const sortedDoctors = useMemo(() => {
    return [...doctorRows].sort((a, b) => {
      const av = mode === 'gross' ? a.gross : a.net;
      const bv = mode === 'gross' ? b.gross : b.net;
      return bv - av;
    });
  }, [doctorRows, mode]);

  return (
    <section
      aria-labelledby="branch-performance-heading"
      className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm p-6 space-y-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p
            id="branch-performance-heading"
            className="text-xs font-semibold uppercase tracking-widest"
            style={{ color: '#13294B', opacity: 0.55 }}
          >
            {branchName} — active plans
          </p>
          <p className="text-3xl font-semibold mt-2" style={{ color: '#13294B' }} data-testid="branch-hero-total">
            {formatRand(totalForMode)}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {activePlanCount} active {activePlanCount === 1 ? 'plan' : 'plans'} on this branch.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-gray-200 p-0.5" role="tablist" aria-label="Gross or net">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'gross'}
            onClick={() => setMode('gross')}
            data-testid="branch-mode-gross"
            className={`px-3 py-1 text-xs font-semibold rounded-md ${mode === 'gross' ? 'text-white' : 'text-gray-500'}`}
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
            data-testid="branch-mode-net"
            className={`px-3 py-1 text-xs font-semibold rounded-md ${mode === 'net' ? 'text-white' : 'text-gray-500'}`}
            style={mode === 'net'
              ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }
              : {}}
          >
            Net
          </button>
        </div>
      </div>

      <BrandMonthlyChart points={monthly} mode={mode} />

      <div>
        <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#13294B', opacity: 0.55 }}>
          By doctor
        </p>
        {sortedDoctors.length === 0 ? (
          <p className="text-xs text-gray-500">No plans attributed to a doctor on this branch yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100" data-testid="branch-doctor-breakdown">
            {sortedDoctors.map((d) => {
              const value = mode === 'gross' ? d.gross : d.net;
              return (
                <li key={d.providerId} className="py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{d.fullName}</p>
                    <p className="text-[11px] text-gray-500">
                      {d.count} active {d.count === 1 ? 'plan' : 'plans'}
                    </p>
                  </div>
                  <p className="text-sm font-semibold whitespace-nowrap" style={{ color: '#13294B' }}>
                    {formatRand(value)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
