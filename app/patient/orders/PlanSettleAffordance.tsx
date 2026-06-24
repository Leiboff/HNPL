'use client';

import { useEffect, useRef, useState } from 'react';
import PayNowButton from './PayNowButton';
import SettleEntireBillButton from './SettleEntireBillButton';
import type { SelfSettleResult, SettleAllOutcome } from './settle-actions';

// ─── Plan-level settle affordance — one calm CTA per card ──────────────
//
// PRESENTATION ONLY. Conditional logic is unchanged from the previous
// build: 1 outstanding → single "Pay now" button; 2+ outstanding →
// expandable "Manage payments" menu with two options at distinct
// amounts. Routes to the same PayNowButton + SettleEntireBillButton
// + ConfirmChargeDialog underneath, which call the same self-settle
// actions backed by the same atomic claim primitive (RPC + claim/lock
// untouched).
//
// What changed cosmetically:
//   • "Settle…" → "Manage payments" with chevron. A complete, intentional
//     label that says what it does — no truncated ellipsis-only text.
//   • Revealed options are visually subordinate: lighter weight, tighter
//     grouping, indented under the toggle with a left rule so they read
//     as a sub-menu belonging to it, not as peer buttons.
//   • Click-outside + Escape close the menu (real menu semantics).
//   • Single-outstanding case stays a plain primary button — no menu
//     when there's only one thing to do.

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

function ChevronDown({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 8l5 5 5-5" />
    </svg>
  );
}

export default function PlanSettleAffordance({
  planId,
  outstandingCount,
  outstandingTotalCents,
  nextOutstanding,
  settleInstalment,
  settleEntirePlan,
}: Props) {
  const [open, setOpen] = useState(false);
  const containerRef    = useRef<HTMLDivElement>(null);

  // Real menu semantics: close on outside tap + Escape. Only attach
  // listeners while the menu is open so resting state has zero cost.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (outstandingCount === 0 || !nextOutstanding) {
    return null;
  }

  // ── 1 outstanding: plain primary "Pay now" — no menu needed.
  if (outstandingCount === 1) {
    return (
      <div className="flex justify-center">
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

  // ── 2+ outstanding: single "Manage payments ▾" entry point. The
  //    two options live inside an indented sub-menu so they read as
  //    belonging to the toggle, not as peer CTAs.
  return (
    <div ref={containerRef} className="flex flex-col items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        style={{
          background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)',
        }}
      >
        Manage payments
        <ChevronDown open={open} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Payment options"
          className="mt-3 w-full max-w-xs pl-3 border-l-2 border-gray-200 flex flex-col gap-1.5"
        >
          {/* Pay-next-instalment — text link, not a button. Subordinate
              to the toggle. Confirm gate (ConfirmChargeDialog) is the
              actual commitment surface. */}
          <PayNowButton
            paymentId={nextOutstanding.paymentId}
            amountToChargeCents={nextOutstanding.chargeAmountCents}
            settleAction={settleInstalment}
            variant="menuItem"
            label={`Pay next instalment · ${formatRandCents(nextOutstanding.chargeAmountCents)}`}
          />
          <SettleEntireBillButton
            planId={planId}
            outstandingTotalCents={outstandingTotalCents}
            outstandingCount={outstandingCount}
            settleAllAction={settleEntirePlan}
            variant="menuItem"
          />
        </div>
      )}
    </div>
  );
}
