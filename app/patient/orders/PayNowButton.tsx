'use client';

import { useState, useTransition } from 'react';
import type { SelfSettleResult } from './settle-actions';

function formatRandCents(cents: number): string {
  const rands = cents / 100;
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

type Props = {
  paymentId:                string;
  /** Cents to be charged: instalment + accrued dunning fees. */
  amountToChargeCents:      number;
  /** Server action wrapper provided by the orders page (avoids server-action import inside a client tree). */
  settleAction: (paymentId: string) => Promise<SelfSettleResult>;
};

export default function PayNowButton({ paymentId, amountToChargeCents, settleAction }: Props) {
  const [isPending, startTransition] = useTransition();
  const [feedback,  setFeedback] = useState<string | null>(null);
  const [done,      setDone] = useState(false);

  function onClick() {
    setFeedback(null);
    startTransition(async () => {
      const result = await settleAction(paymentId);
      if (result.ok && result.status === 'charged') {
        setFeedback(`Charging ${formatRandCents(result.amountChargedCents)}. We'll confirm shortly.`);
        setDone(true);
        return;
      }
      // Surface the failure mode in plain language.
      if (!result.ok) {
        switch (result.status) {
          case 'claim_lost':
            setFeedback(`A payment attempt is already in progress. We'll confirm shortly.`);
            setDone(true);
            return;
          case 'transport_error':
            setFeedback(`Couldn't reach the payment processor. Please try again in a moment.`);
            return;
          case 'not_settleable':
            setFeedback(`This instalment can't be settled right now.`);
            setDone(true);
            return;
          case 'unauthorized':
            setFeedback(`Your session expired. Please log in again.`);
            return;
          case 'not_found':
            setFeedback(`Instalment not found.`);
            return;
        }
      }
    });
  }

  if (done) {
    return (
      <p className="mt-2 text-xs text-gray-500">{feedback}</p>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={isPending}
        className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-50"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {isPending
          ? 'Settling…'
          : `Pay now · ${formatRandCents(amountToChargeCents)}`}
      </button>
      {feedback && <p className="text-xs text-red-600">{feedback}</p>}
    </div>
  );
}
