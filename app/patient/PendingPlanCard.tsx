'use client';

import { useState } from 'react';
import Link from 'next/link';

type Props = {
  planId:            string;
  totalAmount:       number;
  practiceName:      string;
  invoiceNumber?:    string | null;
  practiceReference?: string | null;
  declinePlan: (planId: string) => Promise<{ error: string | null }>;
};

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export default function PendingPlanCard({
  planId,
  totalAmount,
  practiceName,
  invoiceNumber,
  practiceReference,
  declinePlan,
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
    <div className="rounded-2xl border border-amber-300 overflow-hidden">
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

        <div className="flex gap-3">
          <Link
            href={`/patient/orders/${planId}/confirm`}
            className="flex-1 inline-flex items-center justify-center rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-600 transition-colors"
          >
            Review &amp; accept →
          </Link>
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
