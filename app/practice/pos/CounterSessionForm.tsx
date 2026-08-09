'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import QRCode from 'qrcode';
import {
  isAllowedBillAmount,
  MIN_BILL_AMOUNT,
  MAX_BILL_AMOUNT,
  formatRandLimit,
} from '@/lib/config/billAmountLimits';
import type { IssueCounterSessionResult } from './actions';
import type { ProviderOption } from './page';

// ─── CounterSessionForm ──────────────────────────────────────────────
//
// Till-side entry screen. The ONLY state this component holds beyond
// the current in-progress entry is the issued session's token +
// expiry — never the SA ID after submit. The amount + SA ID inputs are
// cleared immediately on a successful issue, and autoComplete is off
// on both, so nothing lingers in the DOM, browser autofill cache, or
// component state for the next patient at a shared till.
//
// "Start next patient" resets the form and drops the current QR
// immediately — the teller is never blocked waiting on one patient's
// phone-side flow before starting the next. (The full multi-session
// board showing all concurrent sessions is a separate piece; this
// form alone already doesn't block on one session's outcome.)

const SESSION_TTL_S = 120;

function formatRand(n: number) {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

type Props = {
  providers:  ProviderOption[];
  practiceId: string;
  issueCounterSession: (data: {
    billAmount:  number;
    saIdNumber:  string;
    cellNumber?: string;
    providerId:  string;
    practiceId:  string;
  }) => Promise<IssueCounterSessionResult>;
};

type Issued = { token: string; expiresAt: string; billAmount: number };

export default function CounterSessionForm({ providers, practiceId, issueCounterSession }: Props) {
  const [billAmount, setBillAmount] = useState('');
  const [saIdNumber, setSaIdNumber] = useState('');
  const [cellNumber, setCellNumber] = useState('');
  const [providerId, setProviderId] = useState(providers[0]?.userId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [issued, setIssued] = useState<Issued | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(SESSION_TTL_S);
  const formRef = useRef<HTMLFormElement>(null);

  const parsedAmount = parseFloat(billAmount);
  const amountValid = billAmount !== '' && isAllowedBillAmount(parsedAmount);

  function resetForSession() {
    // Never leave the SA ID sitting in state on a shared device —
    // clear it (and the amount) the instant the session is issued.
    setBillAmount('');
    setSaIdNumber('');
    setCellNumber('');
    formRef.current?.reset();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!amountValid) {
      setError(`Bill amount must be between ${formatRandLimit(MIN_BILL_AMOUNT)} and ${formatRandLimit(MAX_BILL_AMOUNT)}.`);
      return;
    }
    if (!providerId) {
      setError('Select a provider.');
      return;
    }

    const saId = saIdNumber; // captured before the reset below

    startTransition(async () => {
      const result = await issueCounterSession({
        billAmount: parsedAmount,
        saIdNumber: saId,
        cellNumber: cellNumber.trim() || undefined,
        providerId,
        practiceId,
      });

      // Clear the ID from this component's state regardless of outcome
      // — a failed attempt is not a reason to keep it sitting around.
      resetForSession();

      if (result.error || !result.token || !result.expiresAt) {
        setError(result.error ?? 'Something went wrong. Please try again.');
        return;
      }
      setIssued({ token: result.token, expiresAt: result.expiresAt, billAmount: parsedAmount });
    });
  }

  function handleStartNext() {
    setIssued(null);
    setQrDataUrl(null);
    setError(null);
  }

  // ── Render the QR once a session is issued ─────────────────────────
  useEffect(() => {
    if (!issued) return;
    const appUrl = window.location.origin;
    const url = `${appUrl}/checkout/${issued.token}`;
    let cancelled = false;
    QRCode.toDataURL(url, { width: 320, margin: 1 })
      .then((dataUrl) => { if (!cancelled) setQrDataUrl(dataUrl); })
      .catch(() => { if (!cancelled) setError('Could not render the QR code. Please try again.'); });
    return () => { cancelled = true; };
  }, [issued]);

  // ── Countdown ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!issued) return;
    const tick = () => {
      const remaining = Math.max(0, Math.round((new Date(issued.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [issued]);

  const expired = issued !== null && secondsLeft <= 0;

  if (issued) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center space-y-5">
        {expired ? (
          <>
            <h2 className="text-xl font-semibold text-gray-900">QR expired</h2>
            <p className="text-sm text-gray-500">
              The patient didn&apos;t scan in time. Start a new session for them.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-gray-900">Scan to continue</h2>
            <p className="text-sm text-gray-500">
              {formatRand(issued.billAmount)} — ask the patient to scan this with their own
              phone&apos;s camera.
            </p>
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="Checkout QR code"
                width={240}
                height={240}
                className="mx-auto rounded-xl border border-gray-100"
              />
            ) : (
              <div className="mx-auto h-[240px] w-[240px] animate-pulse rounded-xl bg-gray-100" />
            )}
            <p className="text-sm font-medium text-gray-700" data-testid="pos-qr-countdown">
              Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
            </p>
          </>
        )}
        <button
          type="button"
          onClick={handleStartNext}
          className="inline-flex items-center justify-center rounded-lg bg-[#13294B] px-6 py-2.5 text-sm font-semibold text-white hover:shadow-lg transition-shadow"
        >
          Start next patient
        </button>
      </div>
    );
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-5 rounded-2xl border border-gray-200 bg-white p-6">
      <div>
        <label htmlFor="pos-provider" className="block text-sm font-medium text-gray-700 mb-1.5">
          Provider
        </label>
        <select
          id="pos-provider"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-base text-gray-900"
        >
          {providers.length === 0 && <option value="">No providers on this practice</option>}
          {providers.map((p) => (
            <option key={p.userId} value={p.userId}>{p.firstName} {p.lastName}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="pos-amount" className="block text-sm font-medium text-gray-700 mb-1.5">
          Bill amount
        </label>
        <input
          id="pos-amount"
          type="number"
          inputMode="decimal"
          step="0.01"
          autoComplete="off"
          value={billAmount}
          onChange={(e) => setBillAmount(e.target.value)}
          placeholder="0.00"
          className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-base text-gray-900"
        />
      </div>

      <div>
        <label htmlFor="pos-said" className="block text-sm font-medium text-gray-700 mb-1.5">
          Patient SA ID number
        </label>
        <input
          id="pos-said"
          type="text"
          inputMode="numeric"
          maxLength={13}
          autoComplete="off"
          data-testid="pos-said-input"
          value={saIdNumber}
          onChange={(e) => setSaIdNumber(e.target.value.replace(/\D/g, ''))}
          placeholder="13 digits"
          className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-base text-gray-900 font-mono tabular-nums"
        />
        <p className="mt-1.5 text-xs text-gray-500">
          Never stored on this screen — encrypted the moment you submit.
        </p>
      </div>

      <div>
        <label htmlFor="pos-cell" className="block text-sm font-medium text-gray-700 mb-1.5">
          Cellphone <span className="text-gray-400 font-normal">(optional — SMS fallback if the scan fails)</span>
        </label>
        <input
          id="pos-cell"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={cellNumber}
          onChange={(e) => setCellNumber(e.target.value)}
          placeholder="082 123 4567"
          className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-base text-gray-900"
        />
      </div>

      {error && (
        <div role="alert" className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full inline-flex items-center justify-center rounded-lg bg-[#13294B] [background:linear-gradient(135deg,#13294B_0%,#15A89E_145%)] px-6 py-3 text-sm font-semibold text-white hover:shadow-lg transition-shadow disabled:opacity-60"
      >
        {isPending ? 'Generating QR…' : 'Generate QR'}
      </button>
    </form>
  );
}
