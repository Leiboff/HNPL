'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

type CardInfo = { id: string; card_brand: string; last_four: string };
type PollingState = 'polling' | 'success' | 'timeout';

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

function PollingView() {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-[#0F4C75]/10 mx-auto">
        <svg className="w-7 h-7 text-[#0F4C75] animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden>
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 00-8 8z" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Confirming your card…</h1>
        <p className="mt-1 text-sm text-gray-500">
          Checking for your new card. This usually takes just a moment.
        </p>
      </div>
      <Link
        href="/patient/payment-methods"
        className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-6 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
      >
        Check payment methods
      </Link>
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
        The R1.00 verification charge will be refunded shortly. Your card is ready for future instalment payments.
      </p>
      <Link
        href="/patient/payment-methods"
        className="inline-flex items-center justify-center rounded-lg bg-[#0F4C75] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#0a3a5c] transition-colors"
      >
        View my cards →
      </Link>
    </ResultCard>
  );
}

function TimeoutView() {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-[#0F4C75]/10 mx-auto">
        <svg className="w-7 h-7 text-[#0F4C75]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Still confirming your card…</h1>
        <p className="mt-1 text-sm text-gray-500">
          Taking longer than expected. Your card may still be processing — please check your payment methods in a moment.
        </p>
      </div>
      <Link
        href="/patient/payment-methods"
        className="inline-flex items-center justify-center rounded-lg bg-[#0F4C75] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#0a3a5c] transition-colors"
      >
        Check payment methods →
      </Link>
    </ResultCard>
  );
}

// ─── Polling component ────────────────────────────────────────────────────────

const POLL_TIMEOUT_S = 10;

export default function PollingConfirmation({ since }: { since: string }) {
  const [state, setState] = useState<PollingState>('polling');
  const [card,  setCard]  = useState<CardInfo | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    let elapsed = 0;
    let timerId: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (stopped.current) return;

      elapsed += 1;

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

      if (elapsed >= POLL_TIMEOUT_S) {
        stopped.current = true;
        setState('timeout');
        return;
      }

      timerId = setTimeout(tick, 1000);
    };

    timerId = setTimeout(tick, 1000);
    return () => { stopped.current = true; clearTimeout(timerId); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === 'success' && card) return <SuccessView card={card} />;
  if (state === 'timeout')         return <TimeoutView />;
  return <PollingView />;
}
