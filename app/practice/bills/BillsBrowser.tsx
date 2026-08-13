'use client';

import { useMemo, useState } from 'react';
import BillsTable from '../BillsTable';
import { getInvitation, patientDisplay, type PlanSummary } from '../billHelpers';
import {
  deriveBillLifecycleStatus,
  billLifecycleChip,
  type BillLifecycleStatus,
} from '@/lib/bills/lifecycle';

// ─── The Bills tab's filter + search, around the shared table ─────────────
//
// The dashboard's card is a glance: the most recent bills, under a chart,
// filtered by date and provider along with everything else on that page.
// This is the place you come when you are looking for ONE bill — so the two
// controls are the two things you would know about it: what state it is in,
// and the patient's name or the reference you wrote on it.
//
// DELIBERATELY NOT A QUERY BUILDER. No date range, no provider select, no
// amount bounds, no column sorting. Those exist on the dashboard for the
// chart's sake, and duplicating them here would produce two filter bars
// with different semantics over the same rows — the reader would have to
// learn which page filters what. Two controls that always mean the same
// thing beat six that need explaining.
//
// The TABLE is ../BillsTable, unchanged and unwrapped — the same component
// the dashboard renders. Its four-column layout, per-row disclosure, status
// chips and mobile card view all come for free, and there is no second copy
// of that markup to drift.
//
// FILTERING IS CLIENT-SIDE, over rows the server already sent. That matches
// the dashboard (which filters the same array for its chart) and keeps the
// status filter honest: lifecycle status is DERIVED from plan status plus
// invitation timestamps (lib/bills/lifecycle.ts), not stored, so there is no
// column to filter on in SQL. Deriving it here is the only way the filter
// can agree with the chip the row displays.

// patientDisplay is imported directly rather than passed in: a function
// cannot cross the server/client boundary as a prop, and it is the SAME
// helper ../BillsTable renders in the Patient column — so what you can
// search for is exactly what you can see.
type Props = {
  plans:        PlanSummary[];
  feePercent:   number;
  specialtyMap: Record<string, string>;
};

/** All four, in the order a bill travels through them. */
const STATUSES: BillLifecycleStatus[] = ['sent', 'viewed', 'paid', 'expired'];

function lifecycleOf(plan: PlanSummary): BillLifecycleStatus {
  const inv = getInvitation(plan);
  return deriveBillLifecycleStatus({
    planStatus:           plan.status,
    invitationViewedAt:   inv?.viewed_at   ?? null,
    invitationAcceptedAt: inv?.accepted_at ?? null,
    invitationExpiresAt:  inv?.expires_at  ?? null,
  });
}

export default function BillsBrowser({
  plans,
  feePercent,
  specialtyMap,
}: Props) {
  const [status, setStatus] = useState<'' | BillLifecycleStatus>('');
  const [query,  setQuery]  = useState('');

  // Derived once per row rather than per predicate — the search and the
  // status filter both need it, and it is the same derivation the table's
  // own chip runs.
  const rows = useMemo(
    () => plans.map((plan) => ({ plan, status: lifecycleOf(plan) })),
    [plans],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => (status ? r.status === status : true))
      .filter((r) => {
        if (!q) return true;
        // Patient name, invoice number, and the practice's OWN reference —
        // the last one matters most: it is the string the practice typed on
        // their side, so it is what they will search for when reconciling
        // against their own records.
        const haystack = [
          patientDisplay(r.plan),
          r.plan.invoice_number ?? '',
          r.plan.practice_reference ?? '',
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      })
      .map((r) => r.plan);
  }, [rows, status, query]);

  const hasFilters = Boolean(status || query.trim());

  // Counts per status, so the filter says how much is behind each option
  // rather than making the reader try them one at a time.
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <div
      data-testid="bills-browser"
      className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm"
    >
      <div className="px-4 sm:px-6 py-4 border-b border-gray-100 flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="bills-search">Search bills</label>
        <input
          id="bills-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search patient, invoice or your reference"
          data-testid="bills-search"
          className="min-w-0 flex-1 sm:max-w-xs rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 placeholder:text-gray-400 focus:border-[#15A89E] focus:outline-none"
        />

        <div className="relative">
          <label className="sr-only" htmlFor="bills-status">Filter by status</label>
          <select
            id="bills-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as '' | BillLifecycleStatus)}
            data-testid="bills-status-filter"
            className={`appearance-none rounded-lg border px-3 py-1.5 pr-7 text-sm transition-colors cursor-pointer ${
              status
                ? 'border-blue-300 bg-blue-50 text-blue-700 font-medium'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {/* Label from the shared helper, so this filter cannot end up
                    naming a state differently from the chip in the row. */}
                {billLifecycleChip(s).label}{counts[s] ? ` (${counts[s]})` : ''}
              </option>
            ))}
          </select>
          <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 opacity-40">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        <span data-testid="bills-count" className="text-xs text-gray-400">
          {hasFilters
            ? `${filtered.length} of ${plans.length} bill${plans.length !== 1 ? 's' : ''}`
            : `${plans.length} bill${plans.length !== 1 ? 's' : ''}`}
        </span>

        {hasFilters && (
          <button
            type="button"
            onClick={() => { setStatus(''); setQuery(''); }}
            data-testid="bills-clear"
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors ml-auto"
          >
            Clear
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-b-2xl">
        {plans.length === 0 ? (
          <div className="py-20 text-center" data-testid="bills-empty">
            <p className="font-medium text-gray-500">No bills yet</p>
            <p className="mt-1 text-sm text-gray-400">
              Bills you create will appear here.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          // Distinct from the empty state on purpose: "nothing matches" and
          // "nothing exists" are different problems with different fixes,
          // and telling a practice they have no bills when they have 400 is
          // the kind of thing that generates a support call.
          <div className="py-16 text-center" data-testid="bills-no-matches">
            <p className="font-medium text-gray-500">No bills match your search</p>
            <p className="mt-1 text-sm text-gray-400">
              Try a different name or reference, or clear the status filter.
            </p>
          </div>
        ) : (
          <BillsTable plans={filtered} feePercent={feePercent} specialtyMap={specialtyMap} />
        )}
      </div>
    </div>
  );
}
