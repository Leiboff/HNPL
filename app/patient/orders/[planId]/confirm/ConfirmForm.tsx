'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { usePendingAction } from '@/components/loading/usePendingAction';
import { splitInstalmentsWithExcess, calculatePaymentDates, MIN_FINANCED_RANDS } from '@/lib/finance';
import { isCardValidForPlan } from '@/lib/cardValidity';
import { payWithSavedCard, initializeCardRegistration } from '@/app/patient/actions';
// Every customer-present surface here mounts the SAME Checkout V2
// PeachWidget: card-add (Flow B) runs the zero-amount PA registration
// recipe (see provider.createCardRegistration), and PAYING with a saved
// card is a one-click CIT (3DS-eligible on the known card).
import PeachWidget from '@/app/_components/PeachWidget';
import { cardBrandLabel } from '@/lib/patient/cardBrand';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function formatDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

function bestValidCard(cards: CardRow[], planType: 2 | 3, salaryDay: number): string | null {
  const dates    = calculatePaymentDates(new Date(), salaryDay, planType);
  const lastDate = dates[dates.length - 1];
  const valid    = cards.filter(
    (c) =>
      c.reusable &&
      isCardValidForPlan({ exp_month: c.expiry_month, exp_year: c.expiry_year }, lastDate, 30),
  );
  return (valid.find((c) => c.is_default) ?? valid[0] ?? null)?.id ?? null;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type CardRow = {
  id:           string;
  card_brand:   string;
  last_four:    string;
  expiry_month: number;
  expiry_year:  number;
  reusable:     boolean;
  is_default:   boolean;
};

type CardSearchStatus = 'idle' | 'polling' | 'timed-out';

type Props = {
  planId:           string;
  totalAmount:      number;
  practiceName:     string;
  invoiceNumber:    string | null;
  salaryDay:        number;
  cards:            CardRow[];
  initialPlanType:  2 | 3 | null;
  fromRegistration: boolean;
  blocked:          boolean;
  // RESUME of an abandoned saved-card one-click: the plan is already
  // pending_first_payment with its schedule fixed. The instalment count
  // is locked and the CTA re-opens the same (deterministic-ref) checkout.
  resumeMode:       boolean;
  /**
   * The patient's remaining headroom, in rands, as of the render. Drives the
   * allowance split (product decision 2026-09-02): a bill above it is not
   * refused — the excess rides on instalment 1 — so this is what makes the
   * schedule shown here the schedule that will actually be charged.
   *
   * null means "we could not read it", which is a display problem and not a
   * gate: the claim re-derives the headroom under a row lock either way. We
   * fall back to the fully-financed shape and let the claim correct it.
   * 0 means the patient has no approved limit, or none left.
   */
  availableRands:   number | null;
  /**
   * On a resume the schedule already exists, so it is READ rather than
   * recomputed — payWithSavedCard re-charges the amount on the row, and a
   * recomputation here could quietly disagree with it.
   */
  committedInstalments: number[] | null;
};

const POLL_TIMEOUT_S = 10;

// ─── Component ────────────────────────────────────────────────────────────────

export default function ConfirmForm({
  planId,
  totalAmount,
  practiceName,
  invoiceNumber,
  salaryDay,
  cards,
  initialPlanType,
  fromRegistration,
  blocked,
  resumeMode,
  availableRands,
  committedInstalments,
}: Props) {
  const router = useRouter();

  // planType: pre-set on return from card registration (via ?planType=N)
  const [planType,       setPlanType]       = useState<2 | 3 | null>(initialPlanType);

  // Auto-select the best valid card on mount when initialPlanType is known
  const [selectedCardId, setSelectedCardId] = useState<string | null>(() =>
    initialPlanType ? bestValidCard(cards, initialPlanType, salaryDay) : null,
  );

  // ── The three steps ────────────────────────────────────────────────
  //
  // Review → Schedule → Pay. Only ONE of these is new state: `reviewed`,
  // which records that the patient has read the bill and chosen how many
  // instalments. Everything else is derived from state that already
  // existed, deliberately — a money form is the last place to grow a
  // second state machine that can disagree with the first.
  //
  // The step exists because the old single scroll asked the patient to
  // check an amount against a paper invoice, pick a plan shape, pick a
  // card and consent to a charge, all in one view, with the Pay button
  // visible throughout. Review is the step where nothing can be charged
  // and the only question is "is this bill actually mine" — which is the
  // question the decline route answers, and it was the hardest thing to
  // find on the old screen.
  //
  // Resume skips it: the patient accepted this bill already, the count is
  // locked, and re-asking "does this look right" about a decision they
  // cannot now change would be theatre. Likewise a return trip from card
  // registration, which is mid-flow by definition.
  const [reviewed, setReviewed] = useState(resumeMode || fromRegistration);

  const [wantsNewCard,   setWantsNewCard]   = useState(false);
  const [submitting,     setSubmitting]     = useState(false);
  // Presentation only. canSubmit already folds in !submitting, so the guard
  // is unchanged; this is purely so 'Processing…' does not flash on a fast
  // confirm. See components/loading/usePendingAction.ts.
  const pending = usePendingAction({ pending: submitting });
  const [error,          setError]          = useState<string | null>(null);
  const [addCardLoading, setAddCardLoading] = useState(false);
  const [addCardError,   setAddCardError]   = useState<string | null>(null);
  // Peach Checkout V2 widget lives on the same page — mounted after
  // initializeCardRegistration returns a checkoutId. Null means "no
  // widget mounted".
  const [addCardWidget,  setAddCardWidget]  = useState<{ checkoutId: string; shopperResultUrl: string } | null>(null);
  // Checkout V2 one-click widget for PAYING with a saved card (CIT).
  // Mounted after payWithSavedCard returns a checkoutId. Null = not paying.
  const [payWidget,      setPayWidget]      = useState<{ checkoutId: string; shopperResultUrl: string } | null>(null);

  // Card search status: 'polling' when we return from registration and no card visible yet
  const [cardSearchStatus, setCardSearchStatus] = useState<CardSearchStatus>(() => {
    if (!fromRegistration || !initialPlanType) return 'idle';
    const cardIsAlreadyHere = bestValidCard(cards, initialPlanType, salaryDay) !== null;
    return cardIsAlreadyHere ? 'idle' : 'polling';
  });

  // Stable "since" for the polling window: covers the full Peach checkout flow
  const pollingSince = useRef(
    fromRegistration ? new Date(Date.now() - 5 * 60 * 1000).toISOString() : '',
  );

  // ── Derived schedule ────────────────────────────────────────────────────────

  // ── Derived schedule ──────────────────────────────────────────────────
  //
  // Three sources, in order of authority:
  //
  //   1. the committed rows, on a resume — the amounts that WILL be charged;
  //   2. the allowance split against the headroom, on a fresh acceptance —
  //      what the claim will compute from the same inputs;
  //   3. the fully-financed split, only when the headroom could not be read.
  //
  // (3) is the pre-2026-09-02 behaviour and is now a fallback rather than the
  // rule: it understates instalment 1 whenever a bill exceeds the headroom,
  // which is exactly the case the allowance model exists to serve.
  const split = planType
    ? splitInstalmentsWithExcess(
        totalAmount,
        planType,
        availableRands ?? totalAmount,
      )
    : null;

  const schedule = planType && split
    ? (() => {
        const amounts = committedInstalments && committedInstalments.length === planType
          ? committedInstalments
          : split.instalments;
        const dates   = calculatePaymentDates(new Date(), salaryDay, planType);
        return amounts.map((amount, i) => ({ amount, date: dates[i] }));
      })()
    : null;

  // The part of the bill that is above the allowance and so is collected up
  // front rather than financed. Suppressed on a resume, where the amounts are
  // simply what the rows say and the explanation was given at acceptance.
  const excessRands = !resumeMode && split && split.excess > 0 ? split.excess : 0;

  // Not enough headroom to finance anything at all. The claim refuses this
  // with `below_minimum`, so the honest thing is to say so BEFORE the tap
  // rather than render a schedule and a Pay button that cannot work.
  const belowMinimum =
    !resumeMode && availableRands !== null && availableRands < MIN_FINANCED_RANDS;

  // ── Card validity (keyed on last instalment date) ───────────────────────────

  const cardValidity = new Map<string, boolean>();
  if (schedule) {
    const lastDate = schedule[schedule.length - 1].date;
    for (const card of cards) {
      cardValidity.set(
        card.id,
        card.reusable &&
          isCardValidForPlan(
            { exp_month: card.expiry_month, exp_year: card.expiry_year },
            lastDate,
            30,
          ),
      );
    }
  }

  const validCards   = cards.filter((c) => cardValidity.get(c.id));
  const hasValidCard = validCards.length > 0;

  const deadlineStr = schedule
    ? (() => {
        const lastDate = schedule[schedule.length - 1].date;
        const deadline = new Date(lastDate.getTime() + 30 * 24 * 60 * 60 * 1000);
        return deadline.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
      })()
    : null;

  // ── Poll for newly-registered card after a return trip ──────────────────────

  const pollingStoppedRef = useRef(false);
  const hasTriggeredRefreshRef = useRef(false);

  useEffect(() => {
    if (cardSearchStatus !== 'polling') return;

    let elapsed = 0;
    let timerId: ReturnType<typeof setTimeout>;
    pollingStoppedRef.current = false;

    const tick = async () => {
      if (pollingStoppedRef.current) return;
      elapsed += 1;

      try {
        const res = await fetch(
          `/api/payment-methods/recent?since=${encodeURIComponent(pollingSince.current)}`,
          { cache: 'no-store' },
        );
        if (res.ok) {
          const { card } = (await res.json()) as { card: { id: string } | null };
          if (card) {
            pollingStoppedRef.current = true;
            hasTriggeredRefreshRef.current = true;
            // Re-fetch the server component — the new card will appear in cards prop
            router.refresh();
            return;
          }
        }
      } catch {
        // network blip — keep trying
      }

      if (elapsed >= POLL_TIMEOUT_S) {
        pollingStoppedRef.current = true;
        setCardSearchStatus('timed-out');
        return;
      }

      timerId = setTimeout(tick, 1000);
    };

    timerId = setTimeout(tick, 1000);
    return () => { pollingStoppedRef.current = true; clearTimeout(timerId); };
  }, [cardSearchStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-select the new card once router.refresh() delivers updated props ───

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!hasTriggeredRefreshRef.current) return;
    if (validCards.length === 0) return; // props not updated yet
    if (selectedCardId) return; // already selected

    const best = validCards.find((c) => c.is_default) ?? validCards[0] ?? null;
    if (best) {
      setSelectedCardId(best.id);
      setWantsNewCard(false);
      setCardSearchStatus('idle');
    }
  }, [cards.length, validCards.length]); // fires when the refreshed props arrive

  // ── Plan type change — also re-picks the best valid card ───────────────────

  function handlePlanTypeChange(type: 2 | 3) {
    setPlanType(type);

    if (!wantsNewCard) {
      const nowBest = bestValidCard(cards, type, salaryDay);
      if (!selectedCardId || !cards.find((c) => c.id === selectedCardId && cardValidity.get(c.id))) {
        setSelectedCardId(nowBest);
      }
    }
  }

  // ── Add new card — Peach registration-only checkout, mounted inline ──

  async function handleAddNewCard() {
    if (!planType) return;
    setAddCardLoading(true);
    setAddCardError(null);

    const returnTo = `/patient/orders/${planId}/confirm?planType=${planType}&from=registration`;
    const result   = await initializeCardRegistration(returnTo);

    if (result.error || !result.checkoutId || !result.shopperResultUrl) {
      setAddCardError(result.error ?? 'Could not start card registration.');
      setAddCardLoading(false);
      return;
    }
    setAddCardWidget({ checkoutId: result.checkoutId, shopperResultUrl: result.shopperResultUrl });
    setAddCardLoading(false);
  }

  // ── Pay with selected card ─────────────────────────────────────────────────

  async function handleConfirm() {
    if (!planType || !selectedCardId) return;
    setSubmitting(true);
    setError(null);

    const result = await payWithSavedCard(planId, planType, selectedCardId);
    if (result.error || !result.checkoutId || !result.shopperResultUrl) {
      setError(result.error ?? 'Could not start the payment. Please try again.');
      setSubmitting(false);
      return;
    }
    // Saved-card first instalment is a CUSTOMER-PRESENT CIT: mount the
    // Checkout V2 one-click widget (mostly frictionless 3DS on the known
    // card). It completes on /patient/payment-complete, which activates
    // the plan and roots the stored-credential chain.
    setPayWidget({ checkoutId: result.checkoutId, shopperResultUrl: result.shopperResultUrl });
  }

  const canSubmit    = planType !== null && selectedCardId !== null && hasValidCard && !submitting && !wantsNewCard && !blocked && !belowMinimum;
  const selectedCard = cards.find((c) => c.id === selectedCardId);
  const busy         = submitting || addCardLoading;

  // The step the patient is on, 0-indexed. Derived, never stored: the pay
  // widget IS step 3, so mounting it advances the bar without a setState.
  const step = payWidget ? 2 : reviewed ? 1 : 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  // Paying with a saved card — the Checkout V2 one-click widget takes
  // over the surface. It re-presents the KNOWN card for a mostly-
  // frictionless 3DS (the bank may challenge), then navigates to
  // /patient/payment-complete?checkoutId=… which activates the plan.
  if (payWidget) {
    return (
      <Screen step={step}>
        <Intro
          eyebrow="Step 3 of 3 · Pay"
          title="Confirm your first instalment"
          blurb="Your bank may ask you to approve it. Don’t close this screen while it finishes."
        />
        <div className="px-[18px] pt-[22px]">
          <div className="rounded-card bg-white p-[14px]" style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}>
            <PeachWidget
              checkoutId={payWidget.checkoutId}
              entityId={process.env.NEXT_PUBLIC_PEACH_CHECKOUT_ENTITY_ID ?? ''}
              shopperResultUrl={payWidget.shopperResultUrl}
            />
          </div>
          <div className="mt-[14px] text-center">
            <button
              type="button"
              // The plan is now committed (pending_first_payment) with a
              // checkout in flight, so returning to the stale confirm form
              // would dead-end on a re-tap. Leave to orders instead, where
              // the in-flight state shows and the patient can come back.
              onClick={() => { window.location.href = '/patient/orders'; }}
              className="text-[13px] font-semibold underline underline-offset-2"
              style={{ color: 'var(--portal-muted)' }}
              data-testid="confirm-pay-widget-cancel"
            >
              Cancel
            </button>
          </div>
          <Fine>Secured by Peach Payments · 3-D Secure</Fine>
        </div>
      </Screen>
    );
  }

  // Peach widget takes over the surface while it's mounted. The
  // shopperResultUrl brings the patient back to the same route with
  // ?from=registration so the polling-fallback re-scans for the new card.
  if (addCardWidget) {
    return (
      <Screen step={step}>
        {/* Verification language, never payment language: this widget runs
            a zero-amount registration, so anything that reads like "pay" or
            "complete the transaction" describes something that is not
            happening. Pinned in phase4-bugs.test.ts. */}
        <Intro
          eyebrow="Add a card"
          title="Enter your card details"
          blurb="Enter your card details to add it to your account. We verify it with your bank — no money is taken."
        />
        <div className="px-[18px] pt-[22px]">
          <div className="rounded-card bg-white p-[14px]" style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}>
            <PeachWidget
              mode="registration"
              checkoutId={addCardWidget.checkoutId}
              entityId={process.env.NEXT_PUBLIC_PEACH_CHECKOUT_ENTITY_ID ?? ''}
              shopperResultUrl={addCardWidget.shopperResultUrl}
            />
          </div>
          <div className="mt-[14px] text-center">
            <button
              type="button"
              onClick={() => setAddCardWidget(null)}
              className="text-[13px] font-semibold underline underline-offset-2"
              style={{ color: 'var(--portal-muted)' }}
              data-testid="confirm-widget-cancel"
            >
              Cancel and go back
            </button>
          </div>
        </div>
      </Screen>
    );
  }

  // The bill summary. Shown on BOTH steps, unchanged: the figures a
  // patient is checking against a paper invoice should not move out from
  // under them when they advance.
  const summary = (
    <div
      className="rounded-card p-[18px] flex flex-col gap-[13px]"
      style={{ background: 'var(--portal-wash)', border: '1px solid var(--portal-hairline)' }}
    >
      <SummaryRow k="Practice" v={practiceName} />
      {invoiceNumber && <SummaryRow k="Invoice" v={invoiceNumber} />}
      <SummaryRow k="Total" v={formatRand(totalAmount)} />
      {planType && schedule && (
        <SummaryRow
          k="Instalments"
          v={excessRands > 0
            ? `${planType}, first ${formatRand(schedule[0].amount)}`
            : `${planType} × ${formatRand(schedule[0].amount)}`}
        />
      )}
      {/* Interest is stated as a figure rather than as the word "none",
          because R0.00 on the same row as the total is the claim a patient
          can check. We do NOT extend it to "no fees": late fees can accrue
          on a missed collection, and this screen is where that distinction
          is made or lost. */}
      <SummaryRow k="Interest" v={formatRand(0)} />
    </div>
  );

  // ── Step 1 — Review ───────────────────────────────────────────────────
  if (!reviewed) {
    return (
      <Screen step={step}>
        <Intro
          eyebrow="Step 1 of 3 · Review"
          title={`${practiceName} sent you a bill`}
          blurb="Check the amount against your invoice before you accept. Nothing is collected today."
        />

        <div className="px-[18px] pt-[22px] flex flex-col gap-[12px]">
          {blocked && <Notice tone="amber">You can only have more than one payment plan once you&apos;ve completed your first.</Notice>}
          {summary}

          {/* How many instalments. On resume the count is fixed — the
              schedule already exists and payWithSavedCard re-charges the
              row, so it is not the patient's to change here. */}
          <div className="rounded-card bg-white p-[18px]" style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}>
            <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.16em', color: 'var(--portal-faint)' }}>
              {resumeMode ? 'Your payment plan' : 'Split it into'}
            </p>
            <div className="mt-[13px] grid grid-cols-2 gap-[9px]">
              {([2, 3] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  // On resume the count is fixed (the schedule already exists).
                  disabled={resumeMode || busy || cardSearchStatus === 'polling'}
                  onClick={() => handlePlanTypeChange(n)}
                  className="rounded-tile py-[15px] text-[14px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  style={planType === n
                    ? { background: 'rgba(21,168,158,.1)', border: '1.5px solid var(--portal-accent)', color: 'var(--portal-accent-ink)' }
                    : { background: '#fff', border: '1.5px solid var(--portal-line-soft)', color: 'var(--portal-ink)' }}
                >
                  {n} instalments
                </button>
              ))}
            </div>
          </div>

          {belowMinimum && (
            <Notice tone="amber">
              You don&apos;t have enough of your limit left to split this bill. Pay down
              your current plan first, or contact us if you think your limit should be
              higher.
            </Notice>
          )}
        </div>

        <div className="px-[18px] pt-5 flex flex-col gap-[10px]">
          <button
            type="button"
            onClick={() => setReviewed(true)}
            disabled={!planType || blocked || belowMinimum}
            className="bn-btn-teal rounded-tile py-4 text-[15px] font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Looks right — see schedule
          </button>
          {/* This link NAVIGATES; it does not decline. The decline action
              is confirm-gated and lives on the bill card in the plans list
              (HomeBillCard → declinePlan), which is the only place it can
              ask "are you sure" before telling a practice their bill is
              wrong. So the copy names where to go rather than promising an
              action the tap does not perform — the first draft read
              "Decline it" and left the bill pending. */}
          <Fine>
            Not your bill? You can decline it from{' '}
            <Link href="/patient/orders" className="font-semibold underline underline-offset-2" style={{ color: 'var(--portal-accent-ink)' }}>
              your plans
            </Link>
            {' '}— declining tells the practice this bill is not yours.
          </Fine>
        </div>
      </Screen>
    );
  }

  // ── Step 2 — Schedule, card, consent ──────────────────────────────────
  return (
    <Screen step={step} onBack={resumeMode ? undefined : () => setReviewed(false)}>
      <Intro
        eyebrow={resumeMode ? 'Step 2 of 3 · Resume' : 'Step 2 of 3 · Schedule'}
        title={resumeMode ? 'Finish your first instalment' : 'Here’s how it will be collected'}
        blurb={resumeMode
          ? 'Your plan is already set up. Only the first instalment is left to pay.'
          : 'Interest-free. The first instalment comes off your card as soon as you accept.'}
      />

      <div className="px-[18px] pt-[22px] flex flex-col gap-[12px]">
        {blocked && <Notice tone="amber">You can only have more than one payment plan once you&apos;ve completed your first.</Notice>}
        {summary}

        {/* Schedule */}
        {schedule && (
          <div className="rounded-card bg-white overflow-hidden" style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}>
            {schedule.map((row, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-3 px-[18px] py-[15px]"
                style={i > 0 ? { borderTop: '1px solid var(--portal-hairline)' } : undefined}
              >
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold tabular-nums" style={{ color: 'var(--portal-ink)' }}>
                    {formatRand(row.amount)}
                  </p>
                  <p className="mt-[3px] text-[12px]" style={{ color: 'var(--portal-faint)' }}>
                    {i === 0 ? 'Today' : formatDate(row.date)}
                  </p>
                </div>
                <span
                  className="flex-none text-[12px] font-semibold rounded-full px-[11px] py-1.5"
                  style={{ background: 'rgba(21,168,158,.12)', color: 'var(--portal-accent-ink)' }}
                >
                  {i === 0 ? 'First' : i === schedule.length - 1 ? 'Final' : 'Then'}
                </span>
              </div>
            ))}
            {excessRands > 0 && (
              <p className="px-[18px] py-[14px] text-[12px] leading-[1.6]" style={{ borderTop: '1px solid var(--portal-hairline)', background: 'var(--portal-wash)', color: 'var(--portal-muted)' }}>
                Your available limit covers{' '}
                <span className="font-semibold tabular-nums" style={{ color: 'var(--portal-ink)' }}>{formatRand(split!.financed)}</span>{' '}
                of this bill. The remaining{' '}
                <span className="font-semibold tabular-nums" style={{ color: 'var(--portal-ink)' }}>{formatRand(excessRands)}</span>{' '}
                is collected today with your first instalment, so instalment 1 is
                larger than the rest.
              </p>
            )}
          </div>
        )}

        {belowMinimum && (
          <Notice tone="amber">
            You don&apos;t have enough of your limit left to split this bill. Pay down
            your current plan first, or contact us if you think your limit should be
            higher.
          </Notice>
        )}

        {/* Pay with */}
        {schedule && (
          <div className="rounded-card bg-white p-[18px]" style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}>
            <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.16em', color: 'var(--portal-faint)' }}>
              Pay with
            </p>

            <div className="mt-[13px] flex flex-col gap-[10px]">
              {cardSearchStatus === 'polling' ? (
                <div className="flex items-center gap-3 rounded-tile px-4 py-[15px]" style={{ background: 'var(--portal-wash)' }}>
                  <svg className="w-5 h-5 animate-spin shrink-0" style={{ color: 'var(--portal-accent)' }} fill="none" viewBox="0 0 24 24" aria-hidden>
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 00-8 8z" />
                  </svg>
                  <p className="text-[13.5px]" style={{ color: 'var(--portal-muted)' }}>Confirming your new card…</p>
                </div>

              ) : hasValidCard ? (
                <>
                  {cards.map((card) => {
                    const valid   = cardValidity.get(card.id) ?? false;
                    const checked = !wantsNewCard && selectedCardId === card.id;
                    return (
                      <CardRowLabel
                        key={card.id}
                        checked={checked}
                        disabled={!valid || busy}
                        onSelect={() => {
                          if (valid) {
                            setSelectedCardId(card.id);
                            setWantsNewCard(false);
                            setAddCardError(null);
                          }
                        }}
                        brand={card.card_brand}
                        title={`${card.card_brand} ···· ${card.last_four}`}
                        sub={valid
                          ? `Expires ${card.expiry_month.toString().padStart(2, '0')}/${card.expiry_year}`
                          : 'Expires before this plan’s final payment'}
                        subDanger={!valid}
                      />
                    );
                  })}
                  <CardRowLabel
                    checked={wantsNewCard}
                    disabled={busy}
                    onSelect={() => {
                      setWantsNewCard(true);
                      setSelectedCardId(null);
                      setAddCardError(null);
                      setError(null);
                    }}
                    brand={null}
                    title="Use a new card"
                    sub="Added and verified with your bank"
                  />
                </>

              ) : (
                <div className="rounded-tile p-4 flex flex-col gap-3" style={{ background: 'rgba(245,158,11,.07)', border: '1px solid #F5D49A' }}>
                  {cardSearchStatus === 'timed-out' && (
                    <p className="text-[12px]" style={{ color: '#B45309' }}>
                      Your new card is taking a moment to confirm — try refreshing if it doesn&apos;t appear below.
                    </p>
                  )}
                  <p className="text-[13.5px] leading-[1.5]" style={{ color: '#B45309' }}>
                    You need a card valid until at least{' '}
                    <span className="font-semibold">{deadlineStr}</span> to accept this plan.
                  </p>
                  {addCardError && <p className="text-[13px]" style={{ color: DANGER }}>{addCardError}</p>}
                  <button
                    type="button"
                    onClick={handleAddNewCard}
                    disabled={busy || blocked}
                    className="self-start text-[13.5px] font-semibold underline underline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ color: 'var(--portal-accent-ink)' }}
                  >
                    {addCardLoading ? 'Opening card form…' : 'Add a card and continue →'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {error && <Notice tone="danger">{error}</Notice>}
        {wantsNewCard && addCardError && <Notice tone="danger">{addCardError}</Notice>}
      </div>

      <div className="px-[18px] pt-5 flex flex-col gap-[10px]">
        {wantsNewCard ? (
          <button
            type="button"
            onClick={handleAddNewCard}
            disabled={!planType || busy || blocked}
            className="bn-btn-teal rounded-tile py-4 text-[15px] font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {addCardLoading ? 'Opening card form…' : 'Add a card and continue'}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleConfirm}
            // `canSubmit` already folds in !submitting, but that is React
            // STATE — taps arriving before a re-render all see it as true.
            // pending.disabled adds the hook's synchronous ref-backed guard,
            // which on a confirm-and-pay button is the difference between a
            // double-tap being ignored and it being a second charge.
            disabled={!canSubmit || pending.disabled}
            className="bn-btn-teal rounded-tile py-4 text-[15px] font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending.showLabel ? 'Processing…' : resumeMode ? 'Resume payment' : 'Accept this plan'}
          </button>
        )}

        {/* The consent line is the fine print under the button it consents
            to, not a paragraph four scrolls above it. It names the exact
            first charge, because that is the number leaving the account
            the moment the button is tapped. */}
        {schedule && selectedCard && hasValidCard && !wantsNewCard ? (
          <Fine>
            By accepting you agree to the{' '}
            <Link href="/legal/terms" target="_blank" rel="noopener" className="font-semibold underline underline-offset-2" style={{ color: 'var(--portal-accent-ink)' }}>
              Terms &amp; Conditions
            </Link>
            {' '}and{' '}
            <Link href="/legal/privacy" target="_blank" rel="noopener" className="font-semibold underline underline-offset-2" style={{ color: 'var(--portal-accent-ink)' }}>
              Privacy Policy
            </Link>
            , and to pay the amounts above on the dates shown.{' '}
            <span className="tabular-nums">{formatRand(schedule[0].amount)}</span>{' '}
            is charged to your card now.
          </Fine>
        ) : (
          <Fine>Secured by Peach Payments · 3-D Secure</Fine>
        )}
      </div>
    </Screen>
  );
}

// ─── The flow's chrome ────────────────────────────────────────────────────
//
// White, not the portal sheet: this is the one flow where the patient is
// committing money, and the cards below carry the colour. The 58px top
// pad is the status bar, the same clearance PatientScreen gives every
// other screen. There is no bottom nav here on purpose — a flow you are
// part-way through should not offer four ways out of itself — so the
// bottom pad is the flow's own.

const CARD_SHADOW = '0 2px 8px -3px rgba(15,31,58,.09)';
const CARD_BORDER = '1px solid rgba(19,41,75,.06)';
const DANGER      = '#B42318';

function Screen({ step, onBack, children }: { step: number; onBack?: () => void; children: React.ReactNode }) {
  return (
    <div className="bn-app" style={{ background: '#fff', minHeight: '100%' }}>
      <div className="mx-auto w-full max-w-md md:max-w-xl pt-[58px] pb-10">
        <div className="px-[20px] pt-2 flex items-center gap-3">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className="flex-none w-9 h-9 rounded-full flex items-center justify-center"
              style={{ background: 'var(--portal-wash)', border: '1px solid var(--portal-hairline)', color: 'var(--portal-ink)' }}
            >
              <BackChevron />
            </button>
          ) : (
            <Link
              href="/patient/orders"
              aria-label="Back to plans"
              className="flex-none w-9 h-9 rounded-full flex items-center justify-center"
              style={{ background: 'var(--portal-wash)', border: '1px solid var(--portal-hairline)', color: 'var(--portal-ink)' }}
            >
              <BackChevron />
            </Link>
          )}
          {/* Three segments, one per step. A progress bar rather than
              "Step 2 of 3" alone, because the count in the eyebrow says
              where you are and the bar says how much is left — and the
              second is what makes a patient willing to start. */}
          <div className="flex-1 flex gap-[5px]" role="presentation">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="flex-1 h-1 rounded-full"
                style={{
                  background: i <= step ? 'var(--portal-accent)' : 'var(--portal-line-soft)',
                  transition: 'background-color .5s cubic-bezier(.2,.8,.2,1)',
                }}
              />
            ))}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function BackChevron() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

function Intro({ eyebrow, title, blurb }: { eyebrow: string; title: string; blurb: string }) {
  return (
    <div className="px-[20px] pt-[26px]">
      <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.18em', color: 'var(--portal-faint)' }}>{eyebrow}</p>
      <h1 className="mt-[9px] text-[26px] font-bold leading-[1.2]" style={{ letterSpacing: '-.035em', color: 'var(--portal-ink)' }}>{title}</h1>
      <p className="mt-2.5 text-[13.5px] leading-[1.6]" style={{ color: 'var(--portal-muted)' }}>{blurb}</p>
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex-none text-[13px]" style={{ color: 'var(--portal-muted)' }}>{k}</span>
      <span className="text-[13.5px] font-semibold tabular-nums text-right" style={{ color: 'var(--portal-ink)' }}>{v}</span>
    </div>
  );
}

// Fine print, and --portal-muted rather than --portal-faint. This carries
// the consent line — the exact amount about to be charged, and the Terms
// and Privacy links — at 11.5px. app/globals.css states that faint is
// 2.85:1 and is DECORATION ONLY, never text; material terms set below AA
// is the kind of thing that makes a credit agreement unenforceable, quite
// apart from being unreadable. muted is 4.86:1 on every portal ground.
function Fine({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-center text-[11.5px] leading-[1.5]" style={{ color: 'var(--portal-muted)' }}>{children}</p>
  );
}

function Notice({ tone, children }: { tone: 'amber' | 'danger'; children: React.ReactNode }) {
  const cfg = tone === 'amber'
    ? { bg: 'rgba(245,158,11,.07)', border: '#F5D49A', fg: '#B45309' }
    : { bg: 'rgba(180,35,24,.10)',  border: 'rgba(180,35,24,.25)', fg: DANGER };
  return (
    <div role="alert" className="rounded-tile px-4 py-[14px] text-[13px] leading-[1.5]" style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.fg }}>
      {children}
    </div>
  );
}

// A card option in "Pay with". A real <label> wrapping a real radio, so
// the whole row is the hit target and the keyboard/screen-reader semantics
// are the browser's rather than something reimplemented with divs. The
// visible tick is drawn; the input itself is hidden from sight, never from
// the accessibility tree.
function CardRowLabel({
  checked, disabled, onSelect, brand, title, sub, subDanger = false,
}: {
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  brand: string | null;
  title: string;
  sub: string;
  subDanger?: boolean;
}) {
  return (
    <label
      className={`flex items-center gap-[13px] rounded-tile px-4 py-[15px] transition-colors ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
      style={{
        background: '#fff',
        border: checked ? '1.5px solid var(--portal-accent)' : '1.5px solid var(--portal-hairline)',
      }}
    >
      <input
        type="radio"
        name="card"
        className="sr-only"
        disabled={disabled}
        checked={checked}
        onChange={onSelect}
      />
      <span
        className="flex-none w-[38px] h-[26px] rounded-chip flex items-center justify-center text-[9.5px] font-bold"
        style={{ background: 'var(--portal-wash)', color: 'var(--portal-ink-2)', letterSpacing: '.04em' }}
        aria-hidden
      >
        {brand ? cardBrandLabel(brand) : '+'}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] font-semibold truncate" style={{ color: 'var(--portal-ink)' }}>{title}</span>
        <span className="block mt-[3px] text-[12px]" style={{ color: subDanger ? DANGER : 'var(--portal-faint)' }}>{sub}</span>
      </span>
      <span
        className="flex-none w-5 h-5 rounded-full flex items-center justify-center"
        style={checked
          ? { background: 'var(--portal-accent)', color: '#fff' }
          : { border: '1.5px solid var(--portal-line)' }}
        aria-hidden
      >
        {checked && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </span>
    </label>
  );
}
