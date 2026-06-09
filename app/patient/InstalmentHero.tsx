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

type Props = {
  dueDate:     string;
  total:       number;
  isOverdue:   boolean;
  isToday:     boolean;
  instalments: InstalmentRow[];
};

export default function InstalmentHero({
  dueDate,
  total,
  isOverdue,
  isToday,
  instalments,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left bg-white rounded-3xl shadow-sm p-6 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#15A89E] focus-visible:ring-offset-2"
      >
        {/* Label row with affordance */}
        <div className="flex items-start justify-between gap-2">
          <p
            className={`text-xs font-semibold uppercase tracking-widest ${isOverdue ? 'text-red-600' : ''}`}
            style={isOverdue ? undefined : { color: '#13294B', opacity: 0.6 }}
          >
            {isOverdue ? 'Amount Overdue' : 'Next Instalment'}
          </p>
          <span
            className="text-sm font-medium shrink-0 mt-0.5 transition-colors hover:opacity-70"
            style={{ color: '#13294B' }}
          >
            View breakdown →
          </span>
        </div>

        {/* Amount */}
        <p
          className={`mt-3 text-5xl font-bold tabular-nums ${isOverdue ? 'text-red-600' : ''}`}
          style={isOverdue ? undefined : { color: '#13294B' }}
        >
          {formatRand(total)}
        </p>

        {/* Due-date line */}
        {isOverdue ? (
          <p className="mt-2 text-sm font-medium text-red-600">
            Overdue — was due {formatDate(dueDate)}
          </p>
        ) : isToday ? (
          <p className="mt-2 text-sm text-gray-400">Due today</p>
        ) : (
          <p className="mt-2 text-sm text-gray-400">Due {formatDate(dueDate)}</p>
        )}
      </button>

      <InstalmentBreakdownModal
        open={open}
        onClose={() => setOpen(false)}
        dueDate={dueDate}
        total={total}
        isOverdue={isOverdue}
        instalments={instalments}
      />
    </>
  );
}
