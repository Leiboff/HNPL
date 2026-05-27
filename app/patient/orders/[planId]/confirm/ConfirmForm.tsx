'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { splitInstalments, calculatePaymentDates } from '@/lib/finance';
import { isCardValidForPlan } from '@/lib/cardValidity';
import { payWithSavedCard } from '@/app/patient/actions';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function formatDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type CardRow = {
  id:           string;
  card_brand:   string;
  last_four:    string;
  expiry_month: number;
  expiry_year:  number;
  reusable:     boolean;
  is_default:   boolean;
};

type Props = {
  planId:       string;
  totalAmount:  number;
  practiceName: string;
  invoiceNumber: string | null;
  salaryDay:    number;
  cards:        CardRow[];
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function ConfirmForm({
  planId,
  totalAmount,
  practiceName,
  invoiceNumber,
  salaryDay,
  cards,
}: Props) {
  const [planType,       setPlanType]       = useState<2 | 3 | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [submitting,     setSubmitting]     = useState(false);
  const [error,          setError]          = useState<string | null>(null);

  // ── Derived schedule ────────────────────────────────────────────────────────

  const schedule = useMemo(() => {
    if (!planType) return null;
    const amounts = splitInstalments(totalAmount, planType);
    const dates   = calculatePaymentDates(new Date(), salaryDay, planType);
    return amounts.map((amount, i) => ({ amount, date: dates[i] }));
  }, [planType, totalAmount, salaryDay]);

  // ── Card validity (depends on schedule / last instalment date) ──────────────

  const cardValidity = useMemo(() => {
    const map = new Map<string, boolean>();
    if (!schedule) return map;
    const lastDate = schedule[schedule.length - 1].date;
    for (const card of cards) {
      map.set(
        card.id,
        card.reusable &&
          isCardValidForPlan(
            { exp_month: card.expiry_month, exp_year: card.expiry_year },
            lastDate,
            30,
          ),
      );
    }
    return map;
  }, [schedule, cards]);

  const validCards  = useMemo(() => cards.filter((c) => cardValidity.get(c.id)), [cards, cardValidity]);
  const hasValidCard = validCards.length > 0;

  // Formatted deadline for the "no valid card" callout
  const deadlineStr = useMemo(() => {
    if (!schedule) return null;
    const lastDate = schedule[schedule.length - 1].date;
    const deadline = new Date(lastDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    return deadline.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
  }, [schedule]);

  // ── Plan type change — also picks the best card ─────────────────────────────

  function handlePlanTypeChange(type: 2 | 3) {
    // Compute dates immediately so we can pick the right card before the state re-renders
    const dates     = calculatePaymentDates(new Date(), salaryDay, type);
    const lastDate  = dates[dates.length - 1];
    const nowValid  = cards.filter(
      (c) =>
        c.reusable &&
        isCardValidForPlan({ exp_month: c.expiry_month, exp_year: c.expiry_year }, lastDate, 30),
    );

    setPlanType(type);

    // Keep current selection if still valid; otherwise pick default → first → null
    if (!selectedCardId || !nowValid.find((c) => c.id === selectedCardId)) {
      const best = nowValid.find((c) => c.is_default) ?? nowValid[0] ?? null;
      setSelectedCardId(best?.id ?? null);
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────────

  async function handleConfirm() {
    if (!planType || !selectedCardId) return;
    setSubmitting(true);
    setError(null);

    const result = await payWithSavedCard(planId, planType, selectedCardId);
    if (result.error) {
      setError(result.error);
      setSubmitting(false);
      return;
    }

    // Webhook will activate the plan; redirect to orders so the patient can see the status update
    window.location.href = '/patient/orders';
  }

  const canSubmit    = planType !== null && selectedCardId !== null && hasValidCard && !submitting;
  const selectedCard = cards.find((c) => c.id === selectedCardId);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{practiceName}</h1>
        {invoiceNumber && (
          <p className="font-mono text-sm text-gray-500 mt-0.5">{invoiceNumber}</p>
        )}
        <p className="text-3xl font-bold text-gray-900 mt-2">{formatRand(totalAmount)}</p>
      </div>

      {/* Section 1 — Choose payment plan */}
      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-5 space-y-3">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Choose your payment plan
        </h2>
        <div className="grid grid-cols-2 gap-3">
          {([2, 3] as const).map((n) => (
            <button
              key={n}
              type="button"
              disabled={submitting}
              onClick={() => handlePlanTypeChange(n)}
              className={`rounded-xl border-2 px-4 py-3 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                planType === n
                  ? 'border-blue-500 bg-blue-50 text-blue-800'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
              }`}
            >
              {n} instalments
            </button>
          ))}
        </div>
      </div>

      {/* Section 2 — Payment schedule (once planType chosen) */}
      {schedule && (
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Your payment schedule
            </h2>
          </div>
          <div className="divide-y divide-gray-50">
            {schedule.map((row, i) => (
              <div key={i} className="flex items-center justify-between px-5 py-3">
                <div>
                  <span className="text-sm font-medium text-gray-900">
                    Instalment {i + 1}
                  </span>
                  <span className="ml-2 text-xs text-gray-500">
                    {i === 0 ? 'Today' : formatDate(row.date)}
                  </span>
                </div>
                <span className="text-sm font-semibold text-gray-900 tabular-nums">
                  {formatRand(row.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section 3 — Card selector (once planType chosen) */}
      {schedule && (
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-5 space-y-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Pay with
          </h2>

          {hasValidCard ? (
            <div className="space-y-2">
              {cards.map((card) => {
                const valid   = cardValidity.get(card.id) ?? false;
                const checked = selectedCardId === card.id;
                return (
                  <label
                    key={card.id}
                    className={`flex items-start gap-3 rounded-xl border p-3.5 transition-colors ${
                      !valid
                        ? 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
                        : checked
                        ? 'border-blue-400 bg-blue-50 cursor-pointer'
                        : 'border-gray-200 bg-white hover:border-gray-300 cursor-pointer'
                    }`}
                  >
                    <input
                      type="radio"
                      name="card"
                      disabled={!valid || submitting}
                      checked={checked}
                      onChange={() => { if (valid) setSelectedCardId(card.id); }}
                      className="mt-0.5 h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-900">
                          {card.card_brand}
                        </span>
                        <span className="font-mono text-sm text-gray-700">
                          •••• {card.last_four}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Expires {card.expiry_month.toString().padStart(2, '0')}/{card.expiry_year}
                      </p>
                      {!valid && (
                        <p className="text-xs text-red-500 mt-0.5">
                          Expires before this plan&apos;s final payment
                        </p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
              <p className="text-sm text-amber-900">
                You need a card valid until at least{' '}
                <span className="font-semibold">{deadlineStr}</span> to accept this plan.
              </p>
              <Link
                href="/patient/payment-methods"
                className="inline-flex items-center text-sm font-semibold text-blue-600 hover:underline"
              >
                Add a card →
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Section 4 — Consent line */}
      {schedule && selectedCard && hasValidCard && (
        <p className="text-sm text-gray-600">
          By confirming, you agree to pay the amounts above on the dates shown, and your
          selected card will be charged immediately for the first instalment of{' '}
          <span className="font-semibold">{formatRand(schedule[0].amount)}</span>.
        </p>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!canSubmit}
          className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? 'Processing…' : 'Confirm and Pay First Instalment'}
        </button>
        <Link
          href="/patient/orders"
          className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </Link>
      </div>

    </div>
  );
}
