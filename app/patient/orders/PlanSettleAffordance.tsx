'use client';

import { useState } from 'react';
import PayNowButton from './PayNowButton';
import SettleEntireBillButton from './SettleEntireBillButton';
import type { SelfSettleResult, SettleAllOutcome } from './settle-actions';

// ─── Plan-level settle affordance — keyed on outstanding count ─────────
//
// Decides between a single "Pay now" CTA (when exactly one instalment
// is outstanding — both buttons would be the SAME action for the SAME
// amount, so we collapse them) and an expandable choice (when 2+ are
// outstanding — "Pay next instalment" vs "Settle entire bill" now have
// different amounts so the choice is meaningful).
//
// PRESENTATION ONLY. Routes to the same PayNowButton +
// SettleEntireBillButton + ConfirmChargeDialog underneath, which call
// the same self-settle actions (selfSettleInstalment /
// selfSettleEntirePlan) backed by the same atomic claim primitive
// (attemptChargeInstalment with selfSettle:true and
// claim_plan_for_settlement RPC). No payment-logic changes.
//
// The two amounts shown in the expanded choice come from the SAME
// sources the existing components already use:
//   • Pay next instalment   — bare instalment + accrued fees on the
//                              next-due payment row (same as the per-row
//                              PayNowButton's amount).
//   • Settle entire bill    — pre-computed display total (sum of
//                              outstanding amounts + fees) already
//                              passed to SettleEntireBillButton; the
//                              authoritative server-side sum is still
//                              computed by the RPC at claim time.

type Props = {
  planId:                  string;
  /** Number of outstanding instalments — drives single vs choice. */
  outstandingCount:        number;
  /** Sum of (amount + dunning_fees_cents) across every outstanding instalment, in cents. */
  outstandingTotalCents:   number;
  /** The next-due outstanding instalment — null when none. */
  nextOutstanding: {
    paymentId:            string;
    chargeAmountCents:    number;
    instalmentNumber:     number;
  } | null;
  settleInstalment:        (paymentId: string) => Promise<SelfSettleResult>;
  settleEntirePlan:        (planId:    string) => Promise<SettleAllOutcome>;
};

function formatRandCents(cents: number): string {
  const rands = cents / 100;
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export default function PlanSettleAffordance({
  planId,
  outstandingCount,
  outstandingTotalCents,
  nextOutstanding,
  settleInstalment,
  settleEntirePlan,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  if (outstandingCount === 0 || !nextOutstanding) {
    return null;
  }

  // ── 1 outstanding: single "Pay now" CTA. "Settle entire bill" is NOT
  //    rendered — it would be the same action for the same amount.
  if (outstandingCount === 1) {
    return (
      <div className="flex flex-col items-center gap-2">
        <PayNowButton
          paymentId={nextOutstanding.paymentId}
          amountToChargeCents={nextOutstanding.chargeAmountCents}
          settleAction={settleInstalment}
          variant="primary"
          label={`Pay now · ${formatRandCents(nextOutstanding.chargeAmountCents)}`}
        />
      </div>
    );
  }

  // ── 2+ outstanding: single primary action that expands to a choice.
  //    Collapsed by default; tap "Settle…" to reveal both options with
  //    their distinct amounts.
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
      >
        Settle…
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 8l5 5 5-5" />
        </svg>
      </button>

      {expanded && (
        <div className="w-full max-w-xs flex flex-col items-stretch gap-2">
          <PayNowButton
            paymentId={nextOutstanding.paymentId}
            amountToChargeCents={nextOutstanding.chargeAmountCents}
            settleAction={settleInstalment}
            variant="primary"
            label={`Pay next instalment · ${formatRandCents(nextOutstanding.chargeAmountCents)}`}
          />
          <SettleEntireBillButton
            planId={planId}
            outstandingTotalCents={outstandingTotalCents}
            outstandingCount={outstandingCount}
            settleAllAction={settleEntirePlan}
          />
        </div>
      )}
    </div>
  );
}
