'use client';

import { useState } from 'react';
import InstalmentBreakdownModal from './InstalmentBreakdownModal';
import type { InstalmentRow } from './InstalmentBreakdownModal';

// Re-exported so page.tsx can import the type without depending on the modal directly.
export type { InstalmentRow };

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

// ─── Hero state taxonomy ────────────────────────────────────────────────
//
// The hero must tell the truth about ladder state — a patient who gets a
// "we'll retry on 1 July" email must see "Retrying 1 July" in the app.
// The state is decided at the page level (defaulted-dominates-failed-
// dominates-scheduled across the same-effective-date group) and passed
// in via `groupState`; the hero just renders accordingly.

type Props = {
  /** Effective date — next_attempt_date when ladder-rescheduled, else due_date. */
  dueDate:     string;
  /** Outstanding total = bare instalment + accrued dunning fees, in Rands. */
  total:       number;
  isOverdue:   boolean;
  isToday:     boolean;
  groupState:  'scheduled' | 'failed' | 'defaulted';
  instalments: InstalmentRow[];
};

export default function InstalmentHero({
  dueDate,
  total,
  isOverdue,
  isToday,
  groupState,
  instalments,
}: Props) {
  const [open, setOpen] = useState(false);

  // State-specific accent / copy. `defaulted` is the most urgent (cap
  // hit, no further retries planned); `failed` is mid-ladder
  // (next_attempt_date set); `scheduled` is the normal upcoming case.
  const isUrgent = groupState !== 'scheduled' || isOverdue;

  const labelText =
    groupState === 'defaulted' ? 'In Default — Please Settle' :
    groupState === 'failed'    ? 'Payment Failed' :
    isOverdue                  ? 'Amount Overdue' :
                                 'Next Instalment';

  const dueLine =
    groupState === 'defaulted' ? (
      <p className="mt-2 text-sm font-medium text-red-600">
        No further retries — settle to clear
      </p>
    ) : groupState === 'failed' ? (
      <p className="mt-2 text-sm font-medium text-red-600">
        We&apos;ll retry on {formatDate(dueDate)}
      </p>
    ) : isOverdue ? (
      <p className="mt-2 text-sm font-medium text-red-600">
        Overdue — was due {formatDate(dueDate)}
      </p>
    ) : isToday ? (
      <p className="mt-2 text-sm text-gray-400">Due today</p>
    ) : (
      <p className="mt-2 text-sm text-gray-400">Due {formatDate(dueDate)}</p>
    );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left bg-white rounded-3xl shadow-sm p-5 sm:p-6 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#15A89E] focus-visible:ring-offset-2 border border-[rgba(19,41,75,.08)]"
      >
        {/* Label row with affordance */}
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

        {/* Amount (outstanding incl. fees) */}
        <p
          className={`mt-3 text-4xl sm:text-5xl font-bold tabular-nums ${isUrgent ? 'text-red-600' : ''}`}
          style={isUrgent ? undefined : { color: '#13294B' }}
        >
          {formatRand(total)}
        </p>

        {dueLine}
      </button>

      <InstalmentBreakdownModal
        open={open}
        onClose={() => setOpen(false)}
        dueDate={dueDate}
        total={total}
        isOverdue={isOverdue}
        groupState={groupState}
        instalments={instalments}
      />
    </>
  );
}
