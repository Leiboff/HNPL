'use client';

import { useState, useMemo } from 'react';
import DateRangePicker from './DateRangePicker';
import BillsBlock from './BillsBlock';
import { providerName } from './billHelpers';
import type { PlanSummary } from './billHelpers';
import type { TradingGateResult } from '@/lib/practice/tradingGate';

type Props = {
  plans:        PlanSummary[];
  feePercent:   number;
  specialtyMap: Record<string, string>;
  practiceName: string;
  gate:         TradingGateResult;
  /** Practice scope forwarded onto CreateBillButton URLs. */
  practiceId?:  string;
};

export default function PracticeDashboardClient({
  plans,
  feePercent,
  specialtyMap,
  practiceName,
  gate,
  practiceId,
}: Props) {
  const [fromDate,   setFromDate]   = useState('');
  const [toDate,     setToDate]     = useState('');
  const [providerId, setProviderId] = useState('');

  // Unique providers derived from plans
  const providers = useMemo(() => {
    const map = new Map<string, string>();
    plans.forEach((p) => {
      if (!p.provider_member_id) return;
      const name = providerName(p);
      if (name !== '—') map.set(p.provider_member_id, name);
    });
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [plans]);

  const filteredPlans = useMemo(() => {
    return plans.filter((p) => {
      const d = p.created_at.slice(0, 10);
      if (fromDate   && d < fromDate)             return false;
      if (toDate     && d > toDate)               return false;
      if (providerId && p.provider_member_id !== providerId) return false;
      return true;
    });
  }, [plans, fromDate, toDate, providerId]);

  const hasFilters = Boolean(fromDate || toDate || providerId);

  return (
    <div className="space-y-6 sm:space-y-8">

      {/* ── Global filter bar ──────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker
          fromDate={fromDate}
          toDate={toDate}
          onChange={(f, t) => { setFromDate(f); setToDate(t); }}
        />

        {providers.length > 1 && (
          <div className="relative">
            <select
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              className={`appearance-none rounded-lg border px-3 py-1.5 pr-7 text-sm transition-colors cursor-pointer ${
                providerId
                  ? 'border-blue-300 bg-blue-50 text-blue-700 font-medium'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 shadow-sm'
              }`}
            >
              <option value="">All providers</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 opacity-40">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        )}

        {hasFilters && (
          <span className="text-xs text-gray-400">
            {filteredPlans.length} of {plans.length} bill{plans.length !== 1 ? 's' : ''}
          </span>
        )}

        {hasFilters && (
          <button
            type="button"
            onClick={() => { setFromDate(''); setToDate(''); setProviderId(''); }}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors ml-auto"
          >
            Clear all
          </button>
        )}
      </div>

      {/* ── The revenue chart used to be here ─────────────────────────
          Moved to /practice/payouts. A 12-month trend is not what the
          screen a practice opens every morning is for, and it sat between
          the payout hero and today's bills. It now lives under the
          deposits it explains, on the money screen that is read monthly.
          Mounted in exactly ONE place — app/practice/payouts/page.tsx —
          and a test asserts it is not back here. */}

      {/* ── Bills table ──────────────────────────────────────────────
          The FULL filtered set, deliberately. The card shows only the most
          recent few (RECENT_BILLS_LIMIT in ./BillsBlock) but its CSV/PDF
          exports carry every matching row, and its count line names both
          numbers — so it needs the whole set, and truncating here instead
          would silently shrink the exports. Do not .slice() this prop. */}
      <BillsBlock
        plans={filteredPlans}
        totalCount={plans.length}
        hasFilters={hasFilters}
        feePercent={feePercent}
        specialtyMap={specialtyMap}
        practiceName={practiceName}
        gate={gate}
        practiceId={practiceId}
      />

    </div>
  );
}
