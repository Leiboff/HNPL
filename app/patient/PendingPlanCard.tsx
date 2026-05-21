'use client';

import { useState } from 'react';
import { splitInstalments, calculatePaymentDates } from '@/lib/finance';

type Props = {
  planId: string;
  totalAmount: number;
  salaryDay: number | null;
  practiceName: string;
  acceptPlan: (planId: string, planType: 2 | 3) => Promise<{ error: string | null }>;
  declinePlan: (planId: string) => Promise<{ error: string | null }>;
};

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function formatDate(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export default function PendingPlanCard({
  planId,
  totalAmount,
  salaryDay,
  practiceName,
  acceptPlan,
  declinePlan,
}: Props) {
  const [planType, setPlanType] = useState<2 | 3 | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasSalaryDay = salaryDay !== null;
  const canAccept = hasSalaryDay && planType !== null;

  const preview =
    planType !== null && hasSalaryDay
      ? (() => {
          const amounts = splitInstalments(totalAmount, planType);
          const dates = calculatePaymentDates(new Date(), salaryDay!, planType);
          return amounts.map((amount, i) => ({ amount, date: dates[i] }));
        })()
      : null;

  async function handleAccept() {
    if (!canAccept || !planType) return;
    setError(null);
    setAccepting(true);
    const result = await acceptPlan(planId, planType);
    if (result.error) {
      setError(result.error);
      setAccepting(false);
    } else {
      window.location.reload();
    }
  }

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

  const busy = accepting || declining;

  return (
    <div className="rounded-2xl border border-amber-300 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-amber-50 border-b border-amber-200">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-semibold text-amber-900">{practiceName}</p>
            <p className="text-sm mt-0.5 text-amber-700">Choose your instalment plan</p>
          </div>
          <p className="text-lg font-semibold text-amber-900 shrink-0">
            {formatRand(totalAmount)}
          </p>
        </div>
      </div>

      <div className="px-6 py-5 bg-amber-50 space-y-5">
        {/* Salary day warning */}
        {!hasSalaryDay && (
          <p className="text-sm text-amber-800 bg-amber-100 border border-amber-300 rounded-lg px-4 py-3">
            Set your salary date above before accepting a plan, so we can schedule payments
            around your payday.
          </p>
        )}

        {/* Instalment choice */}
        <div>
          <p className="text-sm font-medium text-amber-900 mb-2">How many instalments?</p>
          <div className="grid grid-cols-2 gap-3">
            {([2, 3] as const).map((n) => (
              <button
                key={n}
                type="button"
                disabled={!hasSalaryDay || busy}
                onClick={() => setPlanType(n)}
                className={`rounded-xl border-2 px-4 py-3 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  planType === n
                    ? 'border-amber-500 bg-amber-500 text-white'
                    : 'border-amber-300 bg-white text-amber-900 hover:border-amber-400'
                }`}
              >
                {n} payments
              </button>
            ))}
          </div>
        </div>

        {/* Live schedule preview */}
        {preview && (
          <div className="rounded-xl border border-amber-200 bg-white overflow-hidden">
            <div className="px-4 py-2.5 border-b border-amber-100">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                Payment schedule
              </p>
            </div>
            <div className="divide-y divide-amber-50">
              {preview.map((row, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <div>
                    <span className="text-gray-700 font-medium">Instalment {i + 1}</span>
                    {i === 0 ? (
                      <span className="ml-2 text-xs text-green-700 bg-green-50 rounded-full px-2 py-0.5">
                        Due today
                      </span>
                    ) : (
                      <span className="ml-2 text-xs text-gray-400">{formatDate(row.date)}</span>
                    )}
                  </div>
                  <span className="font-semibold text-gray-900 tabular-nums">
                    {formatRand(row.amount)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleAccept}
            disabled={!canAccept || busy}
            className="flex-1 rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {accepting ? 'Accepting…' : 'Accept Plan'}
          </button>
          <button
            type="button"
            onClick={handleDecline}
            disabled={busy}
            className="rounded-lg border border-amber-300 bg-white px-4 py-2.5 text-sm font-medium text-amber-800 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-300 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {declining ? 'Declining…' : 'Decline'}
          </button>
        </div>
      </div>
    </div>
  );
}
