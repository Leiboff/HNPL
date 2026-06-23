'use client';

import { useEffect, useCallback } from 'react';

// ─── ConfirmChargeDialog — two-step guard before EVERY immediate charge ─
//
// Both per-instalment "Pay now" and "Settle entire bill" route through
// this. The dialog states the exact amount + that the card will be
// charged immediately; only [Confirm] fires the action. [Cancel]
// closes without side effects.
//
// Reused by PayNowButton and SettleEntireBillButton so the copy +
// dismissal behaviour stay consistent — a single shared shape for the
// "moment of commitment" UX.

function formatRandCents(cents: number): string {
  const rands = cents / 100;
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

type Props = {
  open:              boolean;
  /** Plain-language headline e.g. "Pay R425.66 now?" — already includes the amount. */
  headline:          string;
  /** Subtitle e.g. "Your card will be charged immediately." */
  subtitle:          string;
  /** Cents we'll charge — displayed on the confirm button so it matches the headline. */
  amountCents:       number;
  /** True while the action is mid-flight; disables both buttons and shows "Charging…". */
  isPending:         boolean;
  onConfirm:         () => void;
  onCancel:          () => void;
};

export default function ConfirmChargeDialog({
  open,
  headline,
  subtitle,
  amountCents,
  isPending,
  onConfirm,
  onCancel,
}: Props) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape' && !isPending) onCancel(); },
    [onCancel, isPending],
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
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="confirm-charge-headline">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => { if (!isPending) onCancel(); }}
        aria-hidden
      />
      <div className="absolute inset-0 flex flex-col justify-end md:items-center md:justify-center md:p-6">
        <div className="relative bg-white w-full md:max-w-sm rounded-t-2xl md:rounded-2xl shadow-xl">
          <div className="px-6 pt-6 pb-4">
            <h2
              id="confirm-charge-headline"
              className="text-base font-semibold"
              style={{ color: '#13294B' }}
            >
              {headline}
            </h2>
            <p className="mt-2 text-sm text-gray-600">{subtitle}</p>
          </div>
          <div className="px-6 pb-6 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onConfirm}
              disabled={isPending}
              className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {isPending ? 'Charging…' : `Confirm — pay ${formatRandCents(amountCents)}`}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={isPending}
              className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
