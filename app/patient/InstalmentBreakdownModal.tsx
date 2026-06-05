'use client';

import { useEffect, useCallback } from 'react';

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

export type InstalmentRow = {
  practiceName:     string;
  instalmentNumber: number;
  planType:         number | null;
  amount:           number;
};

type Props = {
  open:        boolean;
  onClose:     () => void;
  dueDate:     string;
  total:       number;
  isOverdue:   boolean;
  instalments: InstalmentRow[];
};

export default function InstalmentBreakdownModal({
  open,
  onClose,
  dueDate,
  total,
  isOverdue,
  instalments,
}: Props) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [open, handleKey]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />

      {/* Positioning: bottom-sheet on mobile, centered on desktop */}
      <div className="absolute inset-0 flex flex-col justify-end md:items-center md:justify-center md:p-6">
        <div className="relative bg-white w-full md:max-w-md rounded-t-2xl md:rounded-2xl shadow-xl">

          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-900">
              What&apos;s due on {formatDate(dueDate)}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Instalment rows */}
          <div className="divide-y divide-gray-50 px-6">
            {instalments.map((inst, i) => (
              <div key={i} className="flex items-center justify-between py-3.5">
                <div>
                  <p className="text-sm font-medium text-gray-900">{inst.practiceName}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Instalment {inst.instalmentNumber}
                    {inst.planType != null ? ` of ${inst.planType}` : ''}
                  </p>
                </div>
                <span className="text-sm font-semibold tabular-nums text-gray-900">
                  {formatRand(inst.amount)}
                </span>
              </div>
            ))}
          </div>

          {/* Divider + total */}
          <div className="px-6 pb-6 pt-2">
            <div className="border-t border-gray-200 pt-4 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-700">Total</span>
              <span
                className={`text-lg font-bold tabular-nums ${isOverdue ? 'text-red-600' : ''}`}
                style={isOverdue ? undefined : { color: '#0F4C75' }}
              >
                {formatRand(total)}
              </span>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
