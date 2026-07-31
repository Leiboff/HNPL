'use client';

import { useState } from 'react';
import PeachWidget from '@/app/_components/PeachWidget';
import { BillChip, ScheduleStrip } from './_components/CheckoutChrome';

// ─── ResumeCapture — logged-in owner, first-instalment capture ─────────
//
// Rendered by /checkout/[token]/page.tsx for a session user who owns
// an UNCAPTURED plan (status = 'pending_first_payment' AND
// peach_registration_id IS NULL). See resumeFirstInstalmentCapture in
// ./actions.ts for the account/plan/schedule idempotency contract.
//
// Functionally this IS the first-instalment capture step — the same
// widget capture the anonymous CheckoutForm runs. It reads identically
// whether the patient is here for the first time or came back after an
// incomplete attempt: a SINGLE "Confirm and pay" surface, matching the
// fresh CheckoutForm Pay step.
//
// (Historical note: an earlier version branched the copy on a
// first-vs-return flag derived from the stored-checkout id on the
// instalment-1 payment row. That id is stamped during the FIRST
// initiateCheckout — before this capture screen ever renders — so it
// was effectively always set and mislabelled brand-new first attempts
// as "Resume". The distinction was removed; the underlying resume
// action is idempotent and works the same for a first pass or a
// re-entry, so there is nothing for the copy to usefully distinguish.)
//
// Not auto-firing on mount: an explicit "Pay Rx today" CTA matches the
// mental model of the Pay step. A double-click is harmless — the resume
// action mints the same deterministic Peach ref (Peach dedups).

type ResumeAction = (token: string) => Promise<
  | { ok: true; checkoutId: string; amountCents: number; shopperResultUrl: string }
  | { ok: false; error: string }
>;

type Props = {
  token:                 string;
  practiceName:          string;
  totalAmount:           number;
  firstInstalmentAmount: number;
  /** Instalment amounts (Rands), in instalment order. */
  scheduleAmounts:       number[];
  /** Matching due dates as ISO strings ('' when unknown). */
  scheduleDates:         string[];
  resumeAction:          ResumeAction;
};

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export default function ResumeCapture({
  token,
  practiceName,
  totalAmount,
  firstInstalmentAmount,
  scheduleAmounts,
  scheduleDates,
  resumeAction,
}: Props) {
  const [widget, setWidget] = useState<{ checkoutId: string; shopperResultUrl: string } | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const [busy,   setBusy]   = useState(false);

  // Single surface — accurate for both first attempt and re-entry.
  const cta = busy ? 'Setting up payment…' : `Pay ${formatRand(firstInstalmentAmount)} today`;

  // Reconstruct Dates for the ScheduleStrip. Rows with an empty ISO
  // string (unknown due date) are dropped so the strip only shows the
  // dates we actually have.
  const scheduleParsed = scheduleAmounts
    .map((amount, i) => ({ amount, iso: scheduleDates[i] ?? '' }))
    .filter((r) => r.iso !== '');
  const stripAmounts = scheduleParsed.map((r) => r.amount);
  const stripDates   = scheduleParsed.map((r) => new Date(r.iso));
  const showSchedule = stripAmounts.length > 0;

  async function start(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await resumeAction(token);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setWidget({ checkoutId: result.checkoutId, shopperResultUrl: result.shopperResultUrl });
    } catch (err) {
      setError(
        err instanceof Error
          ? `Couldn't reach the payment service (${err.message}). Please try again in a moment.`
          : 'Couldn\'t reach the payment service. Please try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (widget) {
    return (
      <>
        <div className="mb-5">
          <BillChip practiceName={practiceName} totalAmount={totalAmount} />
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="mb-3 text-sm text-gray-600">
            Enter your card details to complete instalment 1. Your saved card will be used for the remaining payments on their due dates.
          </p>
          <PeachWidget
            checkoutId={widget.checkoutId}
            entityId={process.env.NEXT_PUBLIC_PEACH_CHECKOUT_ENTITY_ID ?? ''}
            shopperResultUrl={widget.shopperResultUrl}
          />
          <button
            type="button"
            onClick={() => setWidget(null)}
            className="mt-3 text-xs text-gray-500 underline hover:text-gray-700"
            data-testid="resume-capture-cancel"
          >
            Cancel and go back
          </button>
        </div>
      </>
    );
  }

  return (
    <div data-testid="resume-capture">
      <div className="mb-5">
        <BillChip practiceName={practiceName} totalAmount={totalAmount} />
      </div>

      <div className="rounded-2xl border border-[#E5E9F0] bg-white p-6 shadow-sm space-y-4">
        <div className="space-y-1">
          <h1
            className="text-xl font-semibold text-[#0F1F3A] tracking-[-0.01em]"
            data-testid="resume-capture-heading"
          >
            Confirm and pay
          </h1>
          <p className="text-sm text-[#3A4B66]">Complete instalment 1 to activate your plan.</p>
        </div>

        <div className="rounded-xl bg-[#FAFBFD] border border-[#E5E9F0] p-4">
          <p className="text-xs uppercase tracking-[0.08em] font-medium text-[#7A8AA0]">
            Charging your card now
          </p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-[#13294B]">
            {formatRand(firstInstalmentAmount)}
          </p>
        </div>

        {showSchedule && (
          <ScheduleStrip instalments={stripAmounts} dates={stripDates} />
        )}

        {error && (
          <div
            role="alert"
            data-testid="resume-capture-error"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            {error}
          </div>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={start}
          data-testid="resume-capture-button"
          className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 hover:shadow-lg transition-shadow"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {cta}
        </button>
      </div>

      <p className="text-center text-xs text-[#7A8AA0] mt-6 flex items-center justify-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
          <rect x="5" y="11" width="14" height="9" rx="1.5" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
        Secure payments · Card details never touch betternow
      </p>
    </div>
  );
}
