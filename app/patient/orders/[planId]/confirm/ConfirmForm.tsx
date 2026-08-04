'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { splitInstalments, calculatePaymentDates } from '@/lib/finance';
import { isCardValidForPlan } from '@/lib/cardValidity';
import { payWithSavedCard, initializeCardRegistration } from '@/app/patient/actions';
// Every customer-present surface here mounts the SAME Checkout V2
// PeachWidget: card-add (Flow B) runs the zero-amount PA registration
// recipe (see provider.createCardRegistration), and PAYING with a saved
// card is a one-click CIT (3DS-eligible on the known card).
import PeachWidget from '@/app/_components/PeachWidget';

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
}: Props) {
  const router = useRouter();

  // planType: pre-set on return from card registration (via ?planType=N)
  const [planType,       setPlanType]       = useState<2 | 3 | null>(initialPlanType);

  // Auto-select the best valid card on mount when initialPlanType is known
  const [selectedCardId, setSelectedCardId] = useState<string | null>(() =>
    initialPlanType ? bestValidCard(cards, initialPlanType, salaryDay) : null,
  );

  const [wantsNewCard,   setWantsNewCard]   = useState(false);
  const [submitting,     setSubmitting]     = useState(false);
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

  const schedule = planType
    ? (() => {
        const amounts = splitInstalments(totalAmount, planType);
        const dates   = calculatePaymentDates(new Date(), salaryDay, planType);
        return amounts.map((amount, i) => ({ amount, date: dates[i] }));
      })()
    : null;

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

  const canSubmit    = planType !== null && selectedCardId !== null && hasValidCard && !submitting && !wantsNewCard && !blocked;
  const selectedCard = cards.find((c) => c.id === selectedCardId);
  const busy         = submitting || addCardLoading;

  // ── Render ──────────────────────────────────────────────────────────────────

  // Paying with a saved card — the Checkout V2 one-click widget takes
  // over the surface. It re-presents the KNOWN card for a mostly-
  // frictionless 3DS (the bank may challenge), then navigates to
  // /patient/payment-complete?checkoutId=… which activates the plan.
  if (payWidget) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{practiceName}</h1>
          <p className="mt-2 text-sm text-gray-600">
            Confirm your first instalment. You may be asked by your bank to approve it.
          </p>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <PeachWidget
            checkoutId={payWidget.checkoutId}
            entityId={process.env.NEXT_PUBLIC_PEACH_CHECKOUT_ENTITY_ID ?? ''}
            shopperResultUrl={payWidget.shopperResultUrl}
          />
          <button
            type="button"
            // The plan is now committed (pending_first_payment) with a
            // checkout in flight, so returning to the stale confirm form
            // would dead-end on a re-tap. Leave to orders instead, where
            // the in-flight state shows and the patient can come back.
            onClick={() => { window.location.href = '/patient/orders'; }}
            className="mt-3 text-xs text-gray-500 underline hover:text-gray-700"
            data-testid="confirm-pay-widget-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Peach widget takes over the surface while it's mounted. The
  // shopperResultUrl brings the patient back to the same route with
  // ?from=registration so the polling-fallback re-scans for the new card.
  if (addCardWidget) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{practiceName}</h1>
          <p className="mt-2 text-sm text-gray-600">Enter your card details to add it to your account.</p>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="mb-3 text-xs text-gray-500">
            We verify your card with your bank — no money is taken.
          </p>
          <PeachWidget
            checkoutId={addCardWidget.checkoutId}
            entityId={process.env.NEXT_PUBLIC_PEACH_CHECKOUT_ENTITY_ID ?? ''}
            shopperResultUrl={addCardWidget.shopperResultUrl}
          />
          <button
            type="button"
            onClick={() => setAddCardWidget(null)}
            className="mt-3 text-xs text-gray-500 underline hover:text-gray-700"
            data-testid="confirm-widget-cancel"
          >
            Cancel and go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{practiceName}</h1>
        {invoiceNumber && (
          <p className="font-mono text-sm text-gray-500 mt-0.5">{invoiceNumber}</p>
        )}
        <p className="text-3xl font-bold text-gray-900 mt-2">{formatRand(totalAmount)}</p>
      </div>

      {/* Blocked notice */}
      {blocked && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-4">
          <svg
            className="w-5 h-5 text-amber-700 shrink-0 mt-0.5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25z"
            />
          </svg>
          <p className="text-sm font-medium text-amber-900">
            You can only have more than one payment plan once you&apos;ve completed your first.
          </p>
        </div>
      )}

      {/* Section 1 — Choose payment plan (locked on resume) */}
      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-5 space-y-3">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {resumeMode ? 'Your payment plan' : 'Choose your payment plan'}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          {([2, 3] as const).map((n) => (
            <button
              key={n}
              type="button"
              // On resume the count is fixed (the schedule already exists).
              disabled={resumeMode || busy || cardSearchStatus === 'polling'}
              onClick={() => handlePlanTypeChange(n)}
              className={`rounded-xl border-2 px-4 py-3 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                planType === n
                  ? 'border-[#13294B] bg-[#13294B]/10 text-[#13294B]'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
              }`}
            >
              {n} instalments
            </button>
          ))}
        </div>
      </div>

      {/* Section 2 — Payment schedule (once planType is chosen) */}
      {schedule && (
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Your payment schedule
            </h2>
          </div>
          <div className="divide-y divide-gray-50">
            {schedule.map((row, i) => (
              <div key={i} className="flex items-center justify-between px-5 py-3">
                <div>
                  <span className="text-sm font-medium text-gray-900">Instalment {i + 1}</span>
                  <span className="ml-2 text-xs text-gray-500">
                    {i === 0 ? 'Today' : formatDate(row.date)}
                  </span>
                </div>
                <span className="text-sm font-semibold text-gray-900 tabular-nums">
                  {formatRand(row.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section 3 — Card selector (once planType is chosen) */}
      {schedule && (
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-5 space-y-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Pay with
          </h2>

          {/* ── Polling: waiting for newly-registered card to appear ── */}
          {cardSearchStatus === 'polling' ? (
            <div className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3.5">
              <svg className="w-5 h-5 text-[#15A89E] animate-spin shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden>
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 00-8 8z" />
              </svg>
              <p className="text-sm text-gray-600">Confirming your new card…</p>
            </div>

          ) : hasValidCard ? (
            // ── Has at least one valid saved card ──────────────────────────────
            <div className="space-y-2">
              {cards.map((card) => {
                const valid   = cardValidity.get(card.id) ?? false;
                const checked = !wantsNewCard && selectedCardId === card.id;
                return (
                  <label
                    key={card.id}
                    className={`flex items-start gap-3 rounded-xl border p-3.5 transition-colors ${
                      !valid
                        ? 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
                        : checked
                        ? 'border-[#13294B] bg-[#13294B]/10 cursor-pointer'
                        : 'border-gray-200 bg-white hover:border-gray-300 cursor-pointer'
                    }`}
                  >
                    <input
                      type="radio"
                      name="card"
                      disabled={!valid || busy}
                      checked={checked}
                      onChange={() => {
                        if (valid) {
                          setSelectedCardId(card.id);
                          setWantsNewCard(false);
                          setAddCardError(null);
                        }
                      }}
                      className="mt-0.5 h-4 w-4 border-gray-300 text-[#15A89E] focus:ring-[#15A89E]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-900">{card.card_brand}</span>
                        <span className="font-mono text-sm text-gray-700">•••• {card.last_four}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Expires {card.expiry_month.toString().padStart(2, '0')}/{card.expiry_year}
                      </p>
                      {!valid && (
                        <p className="text-xs text-red-500 mt-0.5">
                          Expires before this plan&apos;s final payment
                        </p>
                      )}
                    </div>
                  </label>
                );
              })}

              {/* + Use a new card */}
              <label
                className={`flex items-center gap-3 rounded-xl border p-3.5 transition-colors ${
                  wantsNewCard
                    ? 'border-[#13294B] bg-[#13294B]/10 cursor-pointer'
                    : 'border-gray-200 bg-white hover:border-gray-300 cursor-pointer'
                } ${busy ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <input
                  type="radio"
                  name="card"
                  disabled={busy}
                  checked={wantsNewCard}
                  onChange={() => {
                    setWantsNewCard(true);
                    setSelectedCardId(null);
                    setAddCardError(null);
                    setError(null);
                  }}
                  className="h-4 w-4 border-gray-300 text-[#15A89E] focus:ring-[#15A89E]"
                />
                <span className="text-sm font-medium text-gray-700">+ Use a new card</span>
              </label>
            </div>

          ) : (
            // ── No saved card valid for this plan ──────────────────────────────
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
              {cardSearchStatus === 'timed-out' && (
                <p className="text-xs text-amber-700">
                  Your new card is taking a moment to confirm — try refreshing if it doesn&apos;t appear below.
                </p>
              )}
              <p className="text-sm text-amber-900">
                You need a card valid until at least{' '}
                <span className="font-semibold">{deadlineStr}</span> to accept this plan.
              </p>
              {addCardError && (
                <p className="text-sm text-red-600">{addCardError}</p>
              )}
              <button
                type="button"
                onClick={handleAddNewCard}
                disabled={busy || blocked}
                className="inline-flex items-center text-sm font-semibold text-[#13294B] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {addCardLoading ? 'Opening card form…' : 'Add a card and continue →'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Section 4 — Consent line */}
      {schedule && selectedCard && hasValidCard && !wantsNewCard && (
        <p className="text-sm text-gray-600">
          By confirming, you agree to the{' '}
          <Link
            href="/legal/terms"
            target="_blank"
            rel="noopener"
            className="font-semibold underline underline-offset-2"
            style={{ color: '#15A89E' }}
          >
            Terms &amp; Conditions
          </Link>
          {' '}and{' '}
          <Link
            href="/legal/privacy"
            target="_blank"
            rel="noopener"
            className="font-semibold underline underline-offset-2"
            style={{ color: '#15A89E' }}
          >
            Privacy Policy
          </Link>
          {' '}and to pay the amounts above on the dates shown, and your
          selected card will be charged immediately for the first instalment of{' '}
          <span className="font-semibold">{formatRand(schedule[0].amount)}</span>.
        </p>
      )}

      {/* Payment error */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Add-card error (shown in button bar area when wantsNewCard) */}
      {wantsNewCard && addCardError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {addCardError}
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-3">
        {wantsNewCard ? (
          <button
            type="button"
            onClick={handleAddNewCard}
            disabled={!planType || busy || blocked}
            className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            {addCardLoading ? 'Opening card form…' : 'Add a card and continue'}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canSubmit}
            className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            {submitting ? 'Processing…' : resumeMode ? 'Resume payment' : 'Confirm and Pay First Instalment'}
          </button>
        )}
        <Link
          href="/patient/orders"
          className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </Link>
      </div>

    </div>
  );
}
