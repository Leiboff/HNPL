'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { CARDS_SURFACE, cardRetryDestination } from '@/lib/patient/cardReturn';

// ─── Types ────────────────────────────────────────────────────────────────────

type CardInfo = { id: string; card_brand: string; last_four: string };
type PollingState = 'polling' | 'success' | 'timeout';

// Safety-net only. The primary path is the server-side Peach Checkout
// V2 status check on the parent page; this component is rendered when
// that path throws (network blip to Peach, etc.) so we can still
// recover if the webhook lands a row in time.

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS  = 60_000;   // bumped from 10s — the brief

// ─── Shared layout wrapper ────────────────────────────────────────────────────

function ResultCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-6 py-16 flex flex-col items-center text-center">
      <div className="w-full bg-white rounded-2xl border border-gray-200 shadow-sm px-8 py-10 space-y-5">
        {children}
      </div>
    </div>
  );
}

function BrandBadge({ brand }: { brand: string }) {
  const cls =
    brand === 'Visa'       ? 'bg-blue-700 text-white' :
    brand === 'Mastercard' ? 'bg-red-600 text-white'  :
                             'bg-gray-600 text-white';
  return (
    <span className={`inline-flex items-center justify-center rounded px-2 py-0.5 text-xs font-bold tracking-wide ${cls}`}>
      {brand.toUpperCase()}
    </span>
  );
}

// ─── State views ─────────────────────────────────────────────────────────────

function PollingView({ secondsLeft }: { secondsLeft: number }) {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-[var(--portal-ink)] [background:linear-gradient(135deg,var(--portal-ink)_0%,var(--portal-accent)_145%)]/10 mx-auto">
        <svg className="w-7 h-7 text-[var(--portal-ink)] animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden>
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 00-8 8z" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Confirming your card…</h1>
        <p className="mt-1 text-sm text-gray-500">
          Checking for your new card.
          {secondsLeft > 0 && (
            <span className="block mt-1 text-xs text-gray-400 tabular-nums">
              Up to {secondsLeft}s remaining.
            </span>
          )}
        </p>
      </div>
    </ResultCard>
  );
}

function SuccessView({ card }: { card: CardInfo }) {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-green-100 mx-auto">
        <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Card added and verified</h1>
        <div className="mt-2 flex items-center justify-center gap-2">
          <BrandBadge brand={card.card_brand} />
          <span className="font-mono text-sm text-gray-700">•••• {card.last_four}</span>
        </div>
      </div>
      <p className="text-sm text-gray-600">
        We verified your card with your bank — no money was taken. Your card is ready for future instalment payments.
      </p>
      <Link
        href={CARDS_SURFACE}
        className="inline-flex items-center justify-center rounded-lg bg-[var(--portal-ink)] [background:linear-gradient(135deg,var(--portal-ink)_0%,var(--portal-accent)_145%)] px-6 py-2.5 text-sm font-semibold text-white hover:shadow-lg transition-colors"
      >
        View my cards →
      </Link>
    </ResultCard>
  );
}

function TimeoutView() {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-red-100 mx-auto">
        <svg className="w-7 h-7 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">We couldn&apos;t confirm your card</h1>
        <p className="mt-1 text-sm text-gray-500 leading-relaxed">
          We waited 60 seconds and didn&apos;t see your card on file. If the
          verification went through it should appear shortly — otherwise
          try adding your card again.
        </p>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-center justify-center">
        <Link
          href={cardRetryDestination()}
          className="inline-flex items-center justify-center rounded-lg bg-[var(--portal-ink)] [background:linear-gradient(135deg,var(--portal-ink)_0%,var(--portal-accent)_145%)] px-6 py-2.5 text-sm font-semibold text-white hover:shadow-lg transition-colors"
        >
          Try again
        </Link>
        <Link
          href={CARDS_SURFACE}
          className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-6 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
        >
          View my cards
        </Link>
      </div>
    </ResultCard>
  );
}

// ─── Polling component ────────────────────────────────────────────────────────

export default function PollingConfirmation({ since }: { since: string }) {
  const [state, setState] = useState<PollingState>('polling');
  const [card,  setCard]  = useState<CardInfo | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(POLL_TIMEOUT_MS / 1000));
  const stopped = useRef(false);

  useEffect(() => {
    const startedAt = Date.now();
    let timerId: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (stopped.current) return;
      const elapsedMs = Date.now() - startedAt;
      setSecondsLeft(Math.max(0, Math.ceil((POLL_TIMEOUT_MS - elapsedMs) / 1000)));

      try {
        const res = await fetch(
          `/api/payment-methods/recent?since=${encodeURIComponent(since)}`,
          { cache: 'no-store' },
        );
        if (res.ok) {
          const json = (await res.json()) as { card: CardInfo | null };
          if (json.card) {
            stopped.current = true;
            setCard(json.card);
            setState('success');
            return;
          }
        }
      } catch {
        // network blip — keep trying
      }

      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
        stopped.current = true;
        setState('timeout');
        return;
      }
      timerId = setTimeout(tick, POLL_INTERVAL_MS);
    };

    timerId = setTimeout(tick, POLL_INTERVAL_MS);
    return () => { stopped.current = true; clearTimeout(timerId); };
  }, [since]);

  if (state === 'success' && card) return <SuccessView card={card} />;
  if (state === 'timeout')         return <TimeoutView />;
  return <PollingView secondsLeft={secondsLeft} />;
}
