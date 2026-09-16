'use client';

import { useState, useTransition } from 'react';
import ConfirmChargeDialog from './ConfirmChargeDialog';
import { usePendingAction } from '@/components/loading/usePendingAction';
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
  /**
   * The accrued dunning fees inside `amountToChargeCents`, in cents. Lets
   * the confirm sheet show WHAT the total is made of rather than a figure
   * larger than the instalment with no explanation — which is exactly the
   * moment a patient decides the app is charging them for something they
   * were not told about. 0 (the default) renders no breakdown.
   */
  dunningFeesCents?:        number;
  /** Instalment N of M, for the confirm sheet's subtitle. Optional. */
  instalmentNumber?:        number;
  /** Server action wrapper provided by the orders page (avoids server-action import inside a client tree). */
  settleAction: (paymentId: string) => Promise<SelfSettleResult>;
  /**
   * Button label. Defaults to "Pay now" for the per-row compact pill.
   * The plan-level affordance overrides to "Pay next instalment · R…"
   * when 2+ instalments outstanding (so the choice between paying ONE
   * and paying ALL is differentiated by the amounts on each label).
   */
  label?: string;
  /**
   * Visual variant:
   *  • 'compact'  — per-row pill (small, bordered, white bg).
   *  • 'primary'  — full-width primary CTA (1-outstanding case).
   *  • 'menuItem' — light text-style row inside the Manage-payments menu
   *                  (visually subordinate to the menu toggle).
   */
  variant?: 'compact' | 'primary' | 'menuItem';
};

// Used both as a per-row compact pill ("Pay now") and as the plan-level
// primary CTA ("Pay next instalment · R<amount>") via the label /
// variant props. The atomic claim path is identical either way.
export default function PayNowButton({
  paymentId,
  amountToChargeCents,
  dunningFeesCents = 0,
  instalmentNumber,
  settleAction,
  label = 'Pay now',
  variant = 'compact',
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [isPending,  startTransition] = useTransition();
  // This button had NO pending label — it disabled and went silent, which
  // on a slow network is the frozen-app problem in miniature, on a money
  // action. disabled stays immediate; the label appears only if the charge
  // actually takes a moment. See components/loading/usePendingAction.ts.
  const pending = usePendingAction({ pending: isPending });
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
          case 'not_started':
            // The claim was taken and handed straight back without a request
            // reaching Peach, so nothing was charged and the instalment is
            // exactly where it was. This is the one failure on this button
            // that the patient SHOULD retry — note `done` is deliberately
            // not set, so the button stays live.
            setFeedback('We couldn\'t start that payment, and nothing was charged. Please try again.');
            return;
          case 'transport_error':
            // Same reasoning as SettleEntireBillButton (audit A-13): the
            // response did not arrive, which is not the same as the charge
            // not happening. The row stays claimed, so a retry cannot work
            // anyway — and "try again" is how a customer pays twice.
            setFeedback(
              'We couldn\'t confirm this payment with the bank. Do NOT pay again — '
              + 'we\'re checking, and we\'ll update your plan as soon as we know.',
            );
            setDone(true);
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
    const doneCls =
      variant === 'primary'  ? 'text-xs text-gray-500 text-center'  :
      variant === 'menuItem' ? 'text-xs text-gray-500 px-2'         :
                               'text-xs text-gray-500';
    return <p className={doneCls}>{feedback}</p>;
  }

  // variant styles:
  //  • primary  — full-width primary CTA (1-outstanding plan card).
  //  • compact  — per-row pill (legacy; no longer rendered in OrdersView
  //               post-consolidation, but kept for the API in case other
  //               surfaces use it).
  //  • menuItem — left-aligned text row inside the Manage-payments menu.
  //               Subordinate to the menu toggle: no border, no shadow,
  //               teal text colour, hover bg only.
  const buttonCls =
    variant === 'menuItem'
      ? 'bn-row-hover inline-flex w-full items-center justify-between rounded-chip px-2 py-2 text-[13.5px] font-semibold disabled:opacity-50 text-left'
      : variant === 'primary'
        // The plan-detail primary. NAVY, not teal: the design reserves
        // teal for the one commitment tap, and that tap is Pay inside the
        // confirm sheet — this button only opens it.
        ? 'bn-btn-navy inline-flex w-full items-center justify-center rounded-tile px-4 py-[15px] text-[14.5px] font-semibold text-white disabled:opacity-50'
        : 'bn-btn-wash inline-flex items-center justify-center rounded-chip px-3 py-2 text-[12.5px] font-semibold disabled:opacity-50';

  // menuItem renders the label in the brand teal-on-navy gradient text
  // so it reads as "the actionable thing" while staying visually lighter
  // than a full button.
  const labelStyle = variant === 'primary' ? undefined : { color: 'var(--portal-ink)' };

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={pending.disabled}
        className={buttonCls}
        style={labelStyle}
      >
        {pending.showLabel ? 'Charging…' : label}
      </button>
      {feedback && !confirming && (
        <p className={
          variant === 'primary'  ? 'mt-1 text-xs text-red-600 text-center' :
          variant === 'menuItem' ? 'mt-1 text-[11px] text-red-600 px-2'    :
                                   'mt-1 text-[11px] text-red-600'
        }>
          {feedback}
        </p>
      )}

      <ConfirmChargeDialog
        open={confirming}
        headline={`Pay ${formatRandCents(amountToChargeCents)} now?`}
        // A late fee means this is a CATCH-UP, not an early payment, and
        // the eyebrow should say which before the patient reads the figure.
        eyebrow={dunningFeesCents > 0 ? 'Catch up' : 'Pay now'}
        subtitle={
          instalmentNumber
            ? `Instalment ${instalmentNumber} · your card will be charged immediately.`
            : 'Your card will be charged immediately.'
        }
        amountCents={amountToChargeCents}
        breakdown={dunningFeesCents > 0
          ? [
              { label: 'Instalment', amountCents: amountToChargeCents - dunningFeesCents },
              { label: 'Late fee',   amountCents: dunningFeesCents, danger: true },
            ]
          : undefined}
        isPending={isPending}
        onConfirm={fire}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
