'use client';

import { useEffect, useRef, useState } from 'react';
import PeachWidget from '@/app/_components/PeachWidget';
import { BillChip, ScheduleStrip } from './_components/CheckoutChrome';

// ─── ResumeCapture — logged-in owner, first-instalment capture ─────────
//
// Rendered by /checkout/[token]/page.tsx for a session user who owns
// an UNCAPTURED plan (status = 'pending_first_payment' AND
// peach_registration_id IS NULL). See resumeFirstInstalmentCapture in
// ./actions.ts for the account/plan/schedule idempotency contract.
//
// This is the SINGLE confirm+widget surface for the signed-in-owner
// uncaptured-plan case. Two entry paths, distinguished by `autoStart`:
//
//   • autoStart=true — the patient just tapped Pay on CheckoutForm's
//     Pay step (which navigated here with ?capture=auto). They ALREADY
//     confirmed there, so we skip this surface's confirm and fire the
//     capture immediately → the widget mounts. Net: exactly ONE confirm
//     (CheckoutForm's) before the widget, no near-identical repeat.
//   • autoStart=false — a genuine re-entry via the emailed link (no
//     param). They have NOT confirmed in this session, so we show the
//     one confirm ("Confirm and pay" + schedule + amount) → tap → widget.
//
// The underlying resume action is idempotent (mints the same
// deterministic Peach ref, Peach dedups), so firing it automatically is
// safe — it's exactly what an immediate button tap would do.
//
// ─── Auto-start FAILURE never falls back to a second confirm ───────────
//
// The auto-start surface must NEVER degrade into the manual "Confirm and
// pay" view on error — that was the double-confirm the ?capture=auto
// hand-off exists to remove, reachable via the failure path (a Peach/
// network blip dropping the patient onto the second confirm, which then
// worked on a second tap). Instead, on auto-start failure we:
//   1. retry the capture ONCE automatically (after a short backoff), and
//   2. if it still fails, show a COMPACT inline error + a single
//      "Try again" action that re-fires the capture — NOT the full
//      confirm chrome.
// So a signed-in owner sees exactly one confirm before the widget on
// success, and never a second confirm on failure.
//
// Retry safety: the auto-start path always calls the resume action with
// reuseExisting=true. That path reuses the checkoutId initiateCheckout
// already minted + stamped on the instalment-1 row and, in the fallback-
// mint case, mints against the SAME deterministic Peach ref
// (checkoutRef(payment.id)). Peach dedups on merchantTransactionId, so a
// retry can neither create a second checkout nor double-charge.

// Short backoff before the single automatic retry — gives a transient
// slow/aborted Peach or DB read a beat to clear before the second try.
const AUTO_RETRY_DELAY_MS = 800;

type ResumeAction = (
  token: string,
  opts?: { reuseExisting?: boolean },
) => Promise<
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
  /**
   * true → fresh post-Pay hand-off from CheckoutForm (?capture=auto):
   * skip this surface's confirm and mount the widget immediately.
   * false → re-entry via the emailed link: show one confirm first.
   */
  autoStart:             boolean;
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
  autoStart,
  resumeAction,
}: Props) {
  const [widget, setWidget] = useState<{ checkoutId: string; shopperResultUrl: string } | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const [busy,   setBusy]   = useState(false);
  // Terminal auto-start failure: set only after the automatic attempt +
  // one retry have both failed. Gates the compact error+retry card
  // (NOT the manual confirm view). While false during the auto-start
  // window the "setting up" placeholder shows — so the confirm chrome
  // never appears on the hand-off, success OR failure.
  const [autoFailed, setAutoFailed] = useState(false);

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

  // Runs the capture once. Returns true on success (widget mounted),
  // false on any failure (error surfaced). `reuse` maps to the resume
  // action's reuseExisting: the auto-start hand-off reuses the checkout
  // initiateCheckout already minted; a genuine re-entry mints fresh
  // (the stored checkout is past its validity window). Either way the
  // deterministic Peach ref makes the call idempotent.
  async function runCapture(reuse: boolean): Promise<boolean> {
    setError(null);
    setBusy(true);
    try {
      const result = await resumeAction(token, { reuseExisting: reuse });
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setWidget({ checkoutId: result.checkoutId, shopperResultUrl: result.shopperResultUrl });
      return true;
    } catch (err) {
      setError(
        err instanceof Error
          ? `Couldn't reach the payment service (${err.message}). Please try again in a moment.`
          : 'Couldn\'t reach the payment service. Please try again in a moment.',
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Manual "Try again" from the auto-start error card. Clears the
  // terminal flag (so the placeholder shows while in-flight), re-fires
  // the reuse capture, and re-arms the error card only if it fails
  // again. Never routes to the manual confirm view.
  async function retryAutoStart(): Promise<void> {
    setAutoFailed(false);
    const ok = await runCapture(true);
    if (!ok) setAutoFailed(true);
  }

  // Fresh post-Pay hand-off (?capture=auto): fire the capture once on
  // mount so the widget appears immediately — no second confirm. Guarded
  // by a ref so React's dev double-invoke (StrictMode) can't fire it
  // twice. On failure we retry ONCE automatically (after a short
  // backoff) and, only if that also fails, mark autoFailed → the compact
  // error+retry card. We never fall through to the manual confirm view.
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (!autoStart) return;
    if (autoFiredRef.current) return;
    autoFiredRef.current = true;
    let cancelled = false;
    void (async () => {
      let ok = await runCapture(true);
      if (!ok && !cancelled) {
        await new Promise((resolve) => setTimeout(resolve, AUTO_RETRY_DELAY_MS));
        if (!cancelled) ok = await runCapture(true);
      }
      if (!ok && !cancelled) setAutoFailed(true);
    })();
    return () => { cancelled = true; };
    // runCapture is stable for the component's lifetime; deps intentionally
    // limited to autoStart so this fires exactly once on a fresh mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

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

  // ── Auto-start hand-off surface ──────────────────────────────────
  // The whole autoStart case is handled here so the manual confirm view
  // below is UNREACHABLE on the hand-off — success OR failure. That is
  // what guarantees the patient never sees a second confirm.
  if (autoStart) {
    // Terminal failure (auto attempt + one retry both failed): compact
    // inline error + a single "Try again" that re-fires the capture.
    // NOT the full "Confirm and pay" chrome.
    if (autoFailed) {
      return (
        <div data-testid="resume-capture-autostart-error">
          <div className="mb-5">
            <BillChip practiceName={practiceName} totalAmount={totalAmount} />
          </div>
          <div className="rounded-2xl border border-[#E5E9F0] bg-white p-6 shadow-sm space-y-4">
            <div
              role="alert"
              data-testid="resume-capture-error"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              {error ?? 'We couldn\'t set up your payment. Please try again.'}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void retryAutoStart()}
              data-testid="resume-capture-retry"
              className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 hover:shadow-lg transition-shadow"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {busy ? 'Setting up payment…' : 'Try again'}
            </button>
          </div>
        </div>
      );
    }
    // Initial render + in-flight (including the automatic retry window):
    // a quiet "setting up" state, never the confirm chrome.
    return (
      <div data-testid="resume-capture-autostarting">
        <div className="mb-5">
          <BillChip practiceName={practiceName} totalAmount={totalAmount} />
        </div>
        <div className="rounded-2xl border border-[#E5E9F0] bg-white p-6 shadow-sm flex items-center gap-3">
          <svg className="w-5 h-5 text-[#15A89E] animate-spin shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden>
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 00-8 8z" />
          </svg>
          <p className="text-sm text-[#3A4B66]">Setting up your payment…</p>
        </div>
      </div>
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
            First instalment — due today
          </p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-[#13294B]">
            {formatRand(firstInstalmentAmount)}
          </p>
          <p className="mt-1 text-sm text-[#3A4B66]">
            You&apos;ll pay {formatRand(firstInstalmentAmount)} today, on the next screen.
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
          onClick={() => void runCapture(false)}
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
