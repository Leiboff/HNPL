'use client';

import { useState, useTransition } from 'react';
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
};

// Two-step confirm: tap once → confirm panel with the total; tap
// confirm → fire. Stops accidental settle-everything from a fat-finger
// while keeping the affordance one tap away on intent.
export default function SettleEntireBillButton({
  planId,
  outstandingTotalCents,
  outstandingCount,
  settleAllAction,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [isPending,  startTransition] = useTransition();
  const [resultMsg,  setResultMsg]    = useState<string | null>(null);
  const [done,       setDone]         = useState(false);

  function onConfirm() {
    setResultMsg(null);
    startTransition(async () => {
      const result = await settleAllAction(planId);
      if (result.ok && result.status === 'settled_all') {
        const charged = result.results.filter(r => r.outcome === 'charged').length;
        const skipped = result.results.length - charged;
        if (charged === 0) {
          setResultMsg(`Nothing was charged — every instalment was already in progress or unavailable.`);
        } else if (skipped === 0) {
          setResultMsg(`Charging ${formatRandCents(result.totalChargedCents)} across ${charged} instalments. We'll confirm shortly.`);
        } else {
          setResultMsg(`Charging ${formatRandCents(result.totalChargedCents)} across ${charged} of ${result.results.length} instalments. ${skipped} skipped (already in progress or unavailable).`);
        }
        setDone(true);
        return;
      }
      if (!result.ok) {
        switch (result.status) {
          case 'unauthorized':       setResultMsg('Your session expired. Please log in again.'); return;
          case 'plan_not_found':     setResultMsg('Plan not found.'); return;
          case 'nothing_to_settle':  setResultMsg('Nothing outstanding to settle on this plan.'); setDone(true); return;
        }
      }
    });
  }

  if (done) {
    return <p className="mt-2 text-xs text-gray-500">{resultMsg}</p>;
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
      >
        Settle entire bill · {formatRandCents(outstandingTotalCents)}
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
      <p className="text-sm text-gray-800">
        Pay <strong className="tabular-nums">{formatRandCents(outstandingTotalCents)}</strong> now
        to settle {outstandingCount} outstanding instalment{outstandingCount === 1 ? '' : 's'}
        {outstandingCount === 0 ? '' : ' plus any accrued fees'}.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={isPending}
          className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {isPending ? 'Settling…' : `Confirm — pay ${formatRandCents(outstandingTotalCents)}`}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={isPending}
          className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {resultMsg && <p className="text-xs text-red-600">{resultMsg}</p>}
    </div>
  );
}
