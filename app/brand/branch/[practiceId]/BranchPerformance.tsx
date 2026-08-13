'use client';

import BrandMonthlyChart from '@/app/brand/BrandMonthlyChart';
import type { MonthPoint } from '@/lib/brand/monthlyRevenue';
import { formatRand } from '@/app/practice/billHelpers';

// ─── Branch-detail: Performance section (net-only) ─────────────────────
//
// This branch's own revenue view. NET-only — the whole brand surface
// shows what the practice actually receives after commission. The
// gross figure is derivable from computeRevenue but never rendered
// on the brand surface (label says "net of commission" once).

export type DoctorRevenueRow = {
  providerId: string;
  fullName:   string;
  count:      number;
  gross:      number;   // received for parity with computeRevenue; NOT rendered
  net:        number;
};

export type BranchPerformanceProps = {
  branchName:       string;
  totalNet:         number;
  activePlanCount:  number;
  monthly:          MonthPoint[];
  doctorRows:       DoctorRevenueRow[];
};

export default function BranchPerformance({
  branchName,
  totalNet,
  activePlanCount,
  monthly,
  doctorRows,
}: BranchPerformanceProps) {
  const sortedDoctors = [...doctorRows].sort((a, b) => b.net - a.net);

  return (
    <section
      aria-labelledby="branch-performance-heading"
      className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm p-6 space-y-6"
    >
      <div>
        <p
          id="branch-performance-heading"
          className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: '#13294B', opacity: 0.55 }}
        >
          {branchName} — active plans
        </p>
        <p className="text-3xl font-semibold mt-2" style={{ color: '#13294B' }} data-testid="branch-hero-total">
          {formatRand(totalNet)}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {activePlanCount} active {activePlanCount === 1 ? 'plan' : 'plans'} · net of commission
        </p>
      </div>

      <BrandMonthlyChart points={monthly} />

      <div>
        <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#13294B', opacity: 0.55 }}>
          By doctor
        </p>
        {sortedDoctors.length === 0 ? (
          <p className="text-xs text-gray-500">No plans attributed to a doctor on this branch yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100" data-testid="branch-doctor-breakdown">
            {sortedDoctors.map((d) => (
              <li key={d.providerId} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{d.fullName}</p>
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
      </div>
    </section>
  );
}
