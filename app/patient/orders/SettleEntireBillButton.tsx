'use client';

import { useState, useTransition } from 'react';
import ConfirmChargeDialog from './ConfirmChargeDialog';
import { usePendingAction } from '@/components/loading/usePendingAction';
import type { SettleAllOutcome } from './settle-actions';

function formatRandCents(cents: number): string {
  const rands = cents / 100;
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

type Props = {
  planId:                  string;
  /** Sum of (amount + dunning_fees_cents) across every outstanding instalment, in cents. */
  outstandingTotalCents:   number;
  /** Count of non-collected instalments — used for the confirm-step copy. */
  outstandingCount:        number;
  /** Server action — provided by the parent so this client component doesn't import the action file directly. */
  settleAllAction:         (planId: string) => Promise<SettleAllOutcome>;
  /**
   * Visual variant:
   *  • 'standalone' — original full button (kept for the API; not used today).
   *  • 'menuItem'   — light text row inside the Manage-payments menu.
   */
  variant?:                'standalone' | 'menuItem';
};

// Plan-level "Settle entire bill". Button label keeps the rand amount
// (the total IS useful at the plan level — unlike per-row Pay-now where
// the amount is already on the row). Confirms via ConfirmChargeDialog
// before firing the single Peach charge.
export default function SettleEntireBillButton({
  planId,
  outstandingTotalCents,
  outstandingCount,
  settleAllAction,
  variant = 'standalone',
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [isPending,  startTransition] = useTransition();
  // This button had NO pending label — it disabled and went silent, which
  // on a slow network is the frozen-app problem in miniature on a money
  // action. disabled is immediate; the label appears only if the charge
  // actually takes a moment.
  const pending = usePendingAction({ pending: isPending });
  const [resultMsg,  setResultMsg]    = useState<string | null>(null);
  const [done,       setDone]         = useState(false);

  function fire() {
    setResultMsg(null);
    startTransition(async () => {
      const result = await settleAllAction(planId);
      setConfirming(false);
      if (result.ok && result.status === 'charged') {
        setResultMsg(
          `Charging ${formatRandCents(result.amountCents)} for ${result.coveredCount} ` +
          `instalment${result.coveredCount === 1 ? '' : 's'}. We'll confirm shortly.`,
        );
        setDone(true);
        return;
      }
      if (!result.ok) {
        switch (result.status) {
          case 'unauthorized':
            setResultMsg('Your session expired. Please log in again.');
            return;
          case 'plan_not_found':
            setResultMsg('Plan not found.');
            return;
          case 'nothing_to_settle':
            setResultMsg('Nothing outstanding to settle on this plan.');
            setDone(true);
            return;
          case 'race_lost':
            setResultMsg('Some instalments are being collected right now. Please try again in a moment.');
            return;
          case 'transport_error':
            setResultMsg(`Couldn't reach the payment processor. Please try again in a moment.`);
            return;
          case 'declined':
            setResultMsg('The card was declined. Please try again or contact support.');
            return;
          case 'no_registration_id':
            setResultMsg('No saved card on this plan — please contact support.');
            return;
          case 'no_email':
            setResultMsg('Missing account email — please contact support.');
            return;
        }
      }
    });
  }

  const isMenuItem = variant === 'menuItem';

  if (done) {
    return (
      <p className={isMenuItem ? 'text-xs text-gray-500 px-2' : 'mt-2 text-xs text-gray-500 text-center'}>
        {resultMsg}
      </p>
    );
  }

  const buttonCls = isMenuItem
    ? 'inline-flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 text-left'
    : 'inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50';

  const wrapperCls = isMenuItem
    ? 'flex flex-col'
    : 'flex flex-col items-center gap-2';

  return (
    <div className={wrapperCls}>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={pending.disabled}
        className={buttonCls}
        style={isMenuItem ? { color: '#13294B' } : undefined}
      >
        {pending.showLabel
          ? 'Settling…'
          : `Settle entire bill · ${formatRandCents(outstandingTotalCents)}`}
      </button>
      {resultMsg && !confirming && (
        <p className={isMenuItem ? 'text-xs text-red-600 px-2' : 'text-xs text-red-600 text-center'}>
          {resultMsg}
        </p>
      )}

      <ConfirmChargeDialog
        open={confirming}
        headline={`Settle your entire bill of ${formatRandCents(outstandingTotalCents)} now?`}
        subtitle={
          `Your card will be charged immediately for ${outstandingCount} outstanding ` +
          `instalment${outstandingCount === 1 ? '' : 's'} plus any accrued fees.`
        }
        amountCents={outstandingTotalCents}
        isPending={isPending}
        onConfirm={fire}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
