'use client';

import { useState, useTransition } from 'react';
import ConfirmChargeDialog from './ConfirmChargeDialog';
import type { SelfSettleResult } from './settle-actions';

function formatRandCents(cents: number): string {
  const rands = cents / 100;
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

type Props = {
  paymentId:                string;
  /** Cents to be charged: instalment + accrued dunning fees (for failed/defaulted rows; bare instalment on scheduled). */
  amountToChargeCents:      number;
  /** Server action wrapper provided by the orders page (avoids server-action import inside a client tree). */
  settleAction: (paymentId: string) => Promise<SelfSettleResult>;
  /**
   * Button label. Defaults to "Pay now" for the per-row compact pill.
   * The plan-level affordance overrides to "Pay next instalment · R…"
   * when 2+ instalments outstanding (so the choice between paying ONE
   * and paying ALL is differentiated by the amounts on each label).
   */
  label?: string;
  /** Visual variant — compact pill (per-row) or full-width primary CTA (plan-level). */
  variant?: 'compact' | 'primary';
};

// Used both as a per-row compact pill ("Pay now") and as the plan-level
// primary CTA ("Pay next instalment · R<amount>") via the label /
// variant props. The atomic claim path is identical either way.
export default function PayNowButton({
  paymentId,
  amountToChargeCents,
  settleAction,
  label = 'Pay now',
  variant = 'compact',
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [isPending,  startTransition] = useTransition();
  const [feedback,   setFeedback] = useState<string | null>(null);
  const [done,       setDone] = useState(false);

  function fire() {
    setFeedback(null);
    startTransition(async () => {
      const result = await settleAction(paymentId);
      setConfirming(false);
      if (result.ok && result.status === 'charged') {
        setFeedback(`Charging ${formatRandCents(result.amountChargedCents)}. We'll confirm shortly.`);
        setDone(true);
        return;
      }
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
    return <p className={variant === 'primary' ? 'text-xs text-gray-500 text-center' : 'text-xs text-gray-500'}>{feedback}</p>;
  }

  const buttonCls = variant === 'primary'
    ? 'inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50'
    : 'inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-sm disabled:opacity-50';

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={isPending}
        className={buttonCls}
      >
        {label}
      </button>
      {feedback && !confirming && (
        <p className={variant === 'primary' ? 'mt-1 text-xs text-red-600 text-center' : 'mt-1 text-[11px] text-red-600'}>
          {feedback}
        </p>
      )}

      <ConfirmChargeDialog
        open={confirming}
        headline={`Pay ${formatRandCents(amountToChargeCents)} now?`}
        subtitle="Your card will be charged immediately."
        amountCents={amountToChargeCents}
        isPending={isPending}
        onConfirm={fire}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
