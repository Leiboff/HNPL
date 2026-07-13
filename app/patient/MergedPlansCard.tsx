'use client';

import { useState } from 'react';
import Link from 'next/link';
import InstalmentBreakdownModal, { type InstalmentRow } from './InstalmentBreakdownModal';

// ─── MergedPlansCard ─────────────────────────────────────────────────
//
// Single card that replaces the previous "Next Instalment" hero and
// "Your Plans" chips card. Fixes a redundancy where both cards
// itemised the same underlying plans.
//
// Layout:
//   ┌─────────────────────────────────────────────┐
//   │ NEXT INSTALMENT         View breakdown →    │  ← headline zone
//   │ R500.00                                     │
//   │ Due 1 Aug                                   │
//   ├─────────────────────────────────────────────┤  ← divider
//   │ Norwood Medical    1 of 3 paid   R150.00    │  ← per-plan row
//   │ ▇▇▇▇▇▇░░░░                        Due 1 Aug │
//   │ Cape Physio        0 of 2 paid   R350.00    │
//   │ ▇▇░░░░░░░░                        Due 1 Aug │
//   │ View all 4 →                                │  ← overflow hint
//   │ See 2 past plans →                          │  ← historic link
//   └─────────────────────────────────────────────┘
//
// The headline zone opens the same InstalmentBreakdownModal as before
// (unchanged). Rows tap through to /patient/orders.
//
// Zero active plans → compact empty state with the headline hidden and
// a Find-care link (per the "earn the space" brief).

export type MergedPlanRow = {
  id:            string;
  practiceName:  string;
  paid:          number;
  total:         number;
  percent:       number;
  isPaidInFull:  boolean;
  /** That plan's next unpaid instalment (nullable when paid in full or
   *  no upcoming row exists — the row still renders, just without an
   *  amount on the right). */
  nextAmount:    number | null;
  nextDate:      string | null;   // YYYY-MM-DD (effective date)
};

export type MergedHeadline = {
  dueDate:     string;
  total:       number;
  isOverdue:   boolean;
  isToday:     boolean;
  groupState:  'scheduled' | 'failed' | 'defaulted';
  instalments: InstalmentRow[];
};

type Props = {
  headline:    MergedHeadline | null;
  activeCount: number;
  totalCount:  number;
  rows:        MergedPlanRow[];
};

const ROW_CAP = 3;

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export default function MergedPlansCard({ headline, activeCount, totalCount, rows }: Props) {
  const [open, setOpen] = useState(false);

  // ── Zero active plans → compact empty state ────────────────────
  if (activeCount === 0) {
    return (
      <section
        className="bg-white rounded-3xl shadow-sm border border-[rgba(19,41,75,.08)] p-5 sm:p-6"
        data-testid="merged-plans-card"
      >
        <p
          className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: '#13294B', opacity: 0.6 }}
        >
          Your Plans
        </p>
        <div
          className="mt-3 rounded-xl border border-dashed border-gray-200 py-6 text-center"
          data-testid="merged-plans-empty"
        >
          <p className="text-sm text-gray-500">
            {totalCount === 0 ? 'No payment plans yet.' : 'No active plans right now.'}
          </p>
          <Link
            href="/patient/explore"
            className="mt-3 inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            data-testid="merged-plans-find-care"
          >
            Find care →
          </Link>
        </div>
        {totalCount > activeCount && (
          <Link
            href="/patient/orders"
            className="mt-3 inline-flex text-xs font-medium text-[#13294B] underline underline-offset-2"
            data-testid="merged-plans-past-link"
          >
            See {totalCount - activeCount} past plan{totalCount - activeCount === 1 ? '' : 's'} →
          </Link>
        )}
      </section>
    );
  }

  // ── At least one active plan ────────────────────────────────────
  const visible  = rows.slice(0, ROW_CAP);
  const overflow = Math.max(0, rows.length - ROW_CAP);
  const historic = Math.max(0, totalCount - activeCount);

  const isUrgent = headline
    ? (headline.groupState !== 'scheduled' || headline.isOverdue)
    : false;

  const labelText =
    !headline                              ? 'Your Plans' :
    headline.groupState === 'defaulted'    ? 'In Default — Please Settle' :
    headline.groupState === 'failed'       ? 'Payment Failed' :
    headline.isOverdue                     ? 'Amount Overdue' :
                                             'Next Instalment';

  const dueLine =
    !headline ? null :
    headline.groupState === 'defaulted' ? (
      <p className="mt-2 text-sm font-medium text-red-600">
        No further retries — settle to clear
      </p>
    ) : headline.groupState === 'failed' ? (
      <p className="mt-2 text-sm font-medium text-red-600">
        We&apos;ll retry on {formatDate(headline.dueDate)}
      </p>
    ) : headline.isOverdue ? (
      <p className="mt-2 text-sm font-medium text-red-600">
        Overdue — was due {formatDate(headline.dueDate)}
      </p>
    ) : headline.isToday ? (
      <p className="mt-2 text-sm text-gray-400">Due today</p>
    ) : (
      <p className="mt-2 text-sm text-gray-400">Due {formatDate(headline.dueDate)}</p>
    );

  return (
    <>
      <section
        className="bg-white rounded-3xl shadow-sm border border-[rgba(19,41,75,.08)] overflow-hidden"
        data-testid="merged-plans-card"
      >

        {/* ── Headline zone (top) — button that opens the breakdown modal ── */}
        {headline ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            data-testid="merged-plans-headline"
            className="w-full text-left p-5 sm:p-6 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#15A89E] focus-visible:ring-offset-2"
          >
            <div className="flex items-start justify-between gap-2">
              <p
                className={`text-xs font-semibold uppercase tracking-widest ${isUrgent ? 'text-red-600' : ''}`}
                style={isUrgent ? undefined : { color: '#13294B', opacity: 0.6 }}
              >
                {labelText}
              </p>
              <span className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shrink-0 shadow-sm">
                View breakdown →
              </span>
            </div>
            <p
              className={`mt-3 text-4xl sm:text-5xl font-bold tabular-nums ${isUrgent ? 'text-red-600' : ''}`}
              data-testid="merged-plans-headline-amount"
              style={isUrgent ? undefined : { color: '#13294B' }}
            >
              {formatRand(headline.total)}
            </p>
            {dueLine}
          </button>
        ) : (
          <div className="p-5 sm:p-6 pb-3">
            <p
              className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: '#13294B', opacity: 0.6 }}
            >
              Your Plans
            </p>
            <p className="mt-1 text-sm text-gray-500">
              {activeCount} active — nothing due right now.
            </p>
          </div>
        )}

        {/* ── Divider ─────────────────────────────────────────── */}
        <div className="border-t border-gray-100" aria-hidden />

        {/* ── Plan rows ───────────────────────────────────────── */}
        <ul className="divide-y divide-gray-50" data-testid="merged-plans-rows">
          {visible.map((r) => (
            <li key={r.id}>
              <Link
                href="/patient/orders"
                data-testid="merged-plans-row"
                data-plan-id={r.id}
                className="block px-5 py-3.5 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center justify-between gap-3">
                  <p
                    className="text-sm font-semibold truncate min-w-0"
                    style={{ color: '#13294B' }}
                    data-testid="merged-plans-row-name"
                  >
                    {r.practiceName}
                  </p>
                  <p
                    className="text-sm font-semibold tabular-nums shrink-0"
                    style={{ color: '#13294B' }}
                    data-testid="merged-plans-row-amount"
                  >
                    {r.nextAmount != null ? formatRand(r.nextAmount) : '—'}
                  </p>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-gray-500">
                  <span className="tabular-nums" data-testid="merged-plans-row-paid">
                    {r.isPaidInFull ? 'Paid in full' : `${r.paid} of ${r.total} paid`}
                  </span>
                  <span className="tabular-nums shrink-0">
                    {r.nextDate ? `Due ${formatDate(r.nextDate)}` : ''}
                  </span>
                </div>
                <div
                  className="mt-1.5 h-1.5 w-full rounded-full bg-gray-100 overflow-hidden"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={r.percent}
                  aria-label={`${r.practiceName}: ${r.percent}% paid`}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width:      `${r.percent}%`,
                      background: r.isPaidInFull
                        ? '#15A89E'
                        : 'linear-gradient(90deg, #13294B 0%, #15A89E 100%)',
                    }}
                  />
                </div>
              </Link>
            </li>
          ))}
        </ul>

        {/* ── Footer links ────────────────────────────────────── */}
        {(overflow > 0 || historic > 0) && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between text-xs">
            {overflow > 0 ? (
              <Link
                href="/patient/orders"
                className="font-medium text-[#13294B] underline underline-offset-2"
                data-testid="merged-plans-view-all"
              >
                View all {activeCount} →
              </Link>
            ) : <span />}
            {historic > 0 && (
              <Link
                href="/patient/orders"
                className="font-medium text-[#13294B] underline underline-offset-2"
                data-testid="merged-plans-past-link"
              >
                See {historic} past plan{historic === 1 ? '' : 's'} →
              </Link>
            )}
          </div>
        )}

      </section>

      {headline && (
        <InstalmentBreakdownModal
          open={open}
          onClose={() => setOpen(false)}
          dueDate={headline.dueDate}
          total={headline.total}
          isOverdue={headline.isOverdue}
          groupState={headline.groupState}
          instalments={headline.instalments}
        />
      )}
    </>
  );
}
