'use client';

import { useState } from 'react';
import Link from 'next/link';

type Props = {
  planId:             string;
  totalAmount:        number;
  practiceName:       string;
  invoiceNumber?:     string | null;
  practiceReference?: string | null;
  declinePlan: (planId: string) => Promise<{ error: string | null }>;
  blocked?:           boolean;
};

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

function LockIcon() {
  return (
    <svg
      className="w-4 h-4 text-amber-700 shrink-0 mt-0.5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25z"
      />
    </svg>
  );
}

export default function PendingPlanCard({
  planId,
  totalAmount,
  practiceName,
  invoiceNumber,
  practiceReference,
  declinePlan,
  blocked = false,
}: Props) {
  const [declining, setDeclining] = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  async function handleDecline() {
    setError(null);
    setDeclining(true);
    const result = await declinePlan(planId);
    if (result.error) {
      setError(result.error);
      setDeclining(false);
    } else {
      window.location.reload();
    }
  }

  return (
    <div className="rounded-2xl border border-amber-300 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-amber-50 border-b border-amber-200">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-semibold text-amber-900">{practiceName}</p>
            <p className="text-sm mt-0.5 text-amber-700">Awaiting your acceptance</p>
            {invoiceNumber && (
              <p className="font-mono text-xs text-amber-600 mt-1">{invoiceNumber}</p>
            )}
            {practiceReference && (
              <p className="text-xs text-amber-600">Practice ref: {practiceReference}</p>
            )}
          </div>
          <p className="text-lg font-semibold text-amber-900 shrink-0">
            {formatRand(totalAmount)}
          </p>
        </div>
      </div>

      <div className="px-6 py-4 bg-amber-50 space-y-3">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {blocked && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-white px-4 py-3">
            <LockIcon />
            <p className="text-sm text-amber-800">
              You can only have more than one payment plan once you&apos;ve completed your first.
            </p>
          </div>
        )}

        <div className="flex gap-3">
          {blocked ? (
            <span
              aria-disabled="true"
              className="flex-1 inline-flex items-center justify-center rounded-lg bg-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-400 cursor-not-allowed select-none"
            >
              Review &amp; accept →
            </span>
          ) : (
            <Link
              href={`/patient/orders/${planId}/confirm`}
              className="flex-1 inline-flex items-center justify-center rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-600 transition-colors"
            >
              Review &amp; accept →
            </Link>
          )}
          <button
            type="button"
            onClick={handleDecline}
            disabled={declining}
            className="rounded-lg border border-amber-300 bg-white px-4 py-2.5 text-sm font-medium text-amber-800 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-300 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {declining ? 'Declining…' : 'Decline'}
          </button>
        </div>
      </div>
    </div>
  );
}
