'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import QRCode from 'qrcode';
import {
  isAllowedBillAmount,
  MIN_BILL_AMOUNT,
  MAX_BILL_AMOUNT,
  formatRandLimit,
} from '@/lib/config/billAmountLimits';
import type { IssueCounterSessionResult, CounterSessionStage, ProviderOption } from './actions';
import type { DeliveryMethod } from '@/lib/patients/billIdentity';
import { validateSaId, saIdAge, isValidEmail } from '@/lib/validation';
import { formatRand } from '../billHelpers';

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
// form alone already doesn't block on one session's outcome.) Clicking
// it while the session is still non-terminal ALSO closes it out
// server-side (first-timer hard-stop) — see handleStartNext.
//
// First-timer hard-stop: the countdown reaching zero fires
// expireCounterSession (natural — only acts once actually expired) so
// an abandoned session promptly declines its plan rather than sitting
// as a pending off-site bill. A lazy fail-safe on the server (migration
// 0085's expire_stale_checkout_session, called from every read site)
// covers the case where this client-side call never fires at all.
//
// Confirm-at-counter: a lightweight poll (NOT the full realtime board —
// that's a separate piece) watches for the session reaching 'completed'
// so the teller can explicitly acknowledge it. Missing/skipping an
// acknowledgment never blocks "Start next patient".

const SESSION_TTL_S = 120;
const STAGE_POLL_MS = 3000;

/**
 * A session that has reached an ending — nothing more will happen to it, so
 * there is nothing left to poll for and nothing left to abandon.
 *
 * The complement of lib/checkout/declineCheckoutSessions.ts's
 * OPEN_CHECKOUT_STAGES, listed here rather than imported because that module
 * builds a service-role client and has no business in a client bundle.
 * lib/checkout/paymentFailedStage.test.ts pins the two against each other and
 * against the migration's CHECK, so a stage added to the database without
 * being handled here fails the tests rather than quietly leaving the till
 * polling a dead session forever.
 */
const TERMINAL_STAGES: ReadonlySet<string> = new Set([
  'completed', 'declined', 'expired', 'payment_failed',
]);

function isTerminalStage(stage: CounterSessionStage | null): boolean {
  return stage !== null && TERMINAL_STAGES.has(stage);
}

type Props = {
  providers: ProviderOption[];
  // deviceSecret is injected by TillShell's withDeviceRecovery wrapper —
  // this component stays unaware of the device-auth mechanism entirely,
  // same as it was unaware of user-session auth before this feature.
  issueCounterSession: (data: {
    billAmount:  number;
    saIdNumber:  string;
    cellNumber?: string;
    providerMemberId: string;
    delivery?:     DeliveryMethod;
    patientEmail?: string;
  }) => Promise<IssueCounterSessionResult>;
  expireCounterSession: (token: string, opts?: { force?: boolean }) => Promise<{ error: string | null }>;
  getCounterSessionStage: (token: string) => Promise<{ error: string | null; stage?: CounterSessionStage }>;
  acknowledgeCounterSession: (token: string) => Promise<{ error: string | null }>;
};

type Issued = { token: string; expiresAt: string; billAmount: number };

export default function CounterSessionForm({
  providers,
  issueCounterSession, expireCounterSession, getCounterSessionStage, acknowledgeCounterSession,
}: Props) {
  const [billAmount, setBillAmount] = useState('');
  const [saIdNumber, setSaIdNumber] = useState('');
  const [cellNumber, setCellNumber] = useState('');
  // QR stays the till's default — the patient is standing there. Email is
  // the alternative for a bill issued when they are not, or for someone
  // who can't scan.
  const [delivery, setDelivery] = useState<DeliveryMethod>('qr');
  const [patientEmail, setPatientEmail] = useState('');
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  const [providerId, setProviderId] = useState(providers[0]?.memberId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [issued, setIssued] = useState<Issued | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(SESSION_TTL_S);
  const [stage, setStage] = useState<CounterSessionStage | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Guards the natural-expiry trigger so it fires exactly once per
  // issued session, not on every 1s countdown tick after hitting zero.
  const expiredFiredRef = useRef(false);

  const parsedAmount = parseFloat(billAmount);
  const amountValid = billAmount !== '' && isAllowedBillAmount(parsedAmount);

  function resetForSession() {
    // Never leave the SA ID sitting in state on a shared device —
    // clear it (and the amount) the instant the session is issued.
    setBillAmount('');
    setSaIdNumber('');
    setCellNumber('');
    setPatientEmail('');
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

    // Client-side ID validation, matching the dashboard's posture and the
    // server's own checks. With the patient standing at the counter a
    // mistyped digit is cheapest to catch before the request goes out;
    // lib/patients/billIdentityCapture.ts remains authoritative.
    const trimmedSaId = saIdNumber.trim();
    if (!trimmedSaId || !validateSaId(trimmedSaId).valid) {
      setError('Enter a valid 13-digit SA ID number.');
      return;
    }
    if ((saIdAge(trimmedSaId) ?? 0) < 18) {
      setError('The patient must be 18 or older.');
      return;
    }

    const trimmedEmail = patientEmail.trim();
    if (delivery === 'email' && (!trimmedEmail || !isValidEmail(trimmedEmail))) {
      setError('Enter a valid email address, e.g. patient@example.com.');
      return;
    }

    const saId = trimmedSaId; // captured before the reset below

    startTransition(async () => {
      const result = await issueCounterSession({
        billAmount: parsedAmount,
        saIdNumber: saId,
        cellNumber: cellNumber.trim() || undefined,
        providerMemberId: providerId,
        delivery,
        patientEmail: delivery === 'email' ? trimmedEmail : undefined,
      });

      // Clear the ID from this component's state regardless of outcome
      // — a failed attempt is not a reason to keep it sitting around.
      resetForSession();

      // Email delivery returns no token: there is no QR to render and no
      // countdown to run. The teller needs one thing — did it actually go
      // out — because a silent failure leaves them telling the patient to
      // check an inbox that will stay empty.
      if (delivery === 'email') {
        if (result.error) {
          setError(result.error);
          return;
        }
        setEmailSentTo(result.emailSent ? trimmedEmail : null);
        if (!result.emailSent) {
          setError('The bill was created but we couldn’t email it. Check the address and issue it again.');
        }
        return;
      }

      if (result.error || !result.token || !result.expiresAt) {
        setError(result.error ?? 'Something went wrong. Please try again.');
        return;
      }
      expiredFiredRef.current = false;
      setStage(null);
      setAcknowledging(false);
      setAcknowledged(false);
      setIssued({ token: result.token, expiresAt: result.expiresAt, billAmount: parsedAmount });
    });
  }

  function handleStartNext() {
    // First-timer hard-stop: moving to the next patient IS abandonment
    // of a still-open session, independent of whether the 2-minute
    // timer has actually run out yet. force:true closes it immediately;
    // fire-and-forget — the reset below must never wait on this, and
    // the lazy fail-safe (called from every read site on this token)
    // still catches it even if this specific call fails outright.
    if (issued && !isTerminalStage(stage)) {
      void expireCounterSession(issued.token, { force: true }).catch(() => {
        // Non-fatal — the server-side lazy fail-safe is the backstop.
      });
    }
    setIssued(null);
    setQrDataUrl(null);
    setError(null);
    setStage(null);
    setAcknowledging(false);
    setAcknowledged(false);
  }

  async function handleAcknowledge() {
    if (!issued) return;
    setAcknowledging(true);
    const result = await acknowledgeCounterSession(issued.token);
    setAcknowledging(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setAcknowledged(true);
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
  // First-timer hard-stop: the moment the clock actually reaches zero,
  // fire expireCounterSession(force:false) exactly once. force:false
  // means the server only acts if expires_at has genuinely passed —
  // matches this trigger's own semantics (a real timeout, not an
  // explicit abandon). Fire-and-forget: the till's own display already
  // flips to "QR expired" from secondsLeft alone, and the lazy
  // fail-safe on the server is the backstop if this call is dropped.
  useEffect(() => {
    if (!issued) return;
    const tick = () => {
      const remaining = Math.max(0, Math.round((new Date(issued.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0 && !expiredFiredRef.current) {
        expiredFiredRef.current = true;
        void expireCounterSession(issued.token, { force: false }).catch(() => {
          // Non-fatal — the server-side lazy fail-safe is the backstop.
        });
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [issued, expireCounterSession]);

  // ── Stage poll (Build D: confirm-at-counter) ────────────────────────
  // Minimal — a single-column read, not a realtime subscription (that's
  // the future multi-session board's job). Stops once the session
  // reaches any terminal stage; no point polling further.
  useEffect(() => {
    if (!issued) return;
    if (isTerminalStage(stage)) return;
    let cancelled = false;
    const poll = async () => {
      const result = await getCounterSessionStage(issued.token);
      if (!cancelled && result.stage) setStage(result.stage);
    };
    poll();
    const id = window.setInterval(poll, STAGE_POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [issued, stage, getCounterSessionStage]);

  // "This QR is dead" — the clock ran out, or the session reached an ending
  // that isn't payment. 'completed' is excluded because it has its own panel.
  const expired =
    issued !== null &&
    (secondsLeft <= 0 || (isTerminalStage(stage) && stage !== 'completed'));

  if (issued) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center space-y-5">
        {error && (
          <div role="alert" className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}
        {stage === 'completed' ? (
          <>
            <h2 className="text-xl font-semibold text-gray-900">Payment received</h2>
            <p className="text-sm text-gray-500">
              {formatRand(issued.billAmount)} — the patient completed checkout on their phone.
            </p>
            {/* Confirm-at-counter: the teller's OWN acknowledgment/record-
                keeping step. Separate from and after the patient's own
                automatic payment confirmation (which already happened —
                that's what got us to stage='completed'). Purely additive:
                skipping this never blocks "Start next patient" below. */}
            {acknowledged ? (
              <p className="text-sm font-medium text-green-700" data-testid="pos-acknowledged">
                Acknowledged ✓
              </p>
            ) : (
              <button
                type="button"
                onClick={handleAcknowledge}
                disabled={acknowledging}
                data-testid="pos-acknowledge-button"
                className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-5 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-60"
              >
                {acknowledging ? 'Acknowledging…' : 'Acknowledge'}
              </button>
            )}
          </>
        ) : expired ? (
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
    <form ref={formRef} onSubmit={handleSubmit} data-testid="pos-entry-form" className="space-y-5 rounded-2xl border border-gray-200 bg-white p-6">
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
            <option key={p.memberId} value={p.memberId}>{p.name}</option>
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

      {/* Delivery method — QR default, matching the dashboard */}
      <fieldset data-testid="pos-delivery-toggle">
        <legend className="block text-sm font-medium text-gray-700 mb-1.5">How should the patient get this bill?</legend>
        <div className="flex gap-2">
          {([
            { value: 'qr'    as const, label: 'Show a QR code', hint: 'They scan it here' },
            { value: 'email' as const, label: 'Send by email',  hint: 'They pay in their own time' },
          ]).map(opt => (
            <label
              key={opt.value}
              data-testid={`pos-delivery-${opt.value}`}
              className={`flex-1 cursor-pointer rounded-lg border px-3 py-2.5 text-left transition-colors ${
                delivery === opt.value ? 'border-[#13294B] bg-[#F4F7FC]' : 'border-gray-300'
              }`}
            >
              <input
                type="radio"
                name="pos-delivery"
                value={opt.value}
                checked={delivery === opt.value}
                onChange={() => { setDelivery(opt.value); setError(null); }}
                className="sr-only"
              />
              <span className="block text-sm font-medium text-gray-800">{opt.label}</span>
              <span className="block text-xs text-gray-500">{opt.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {delivery === 'email' && (
        <div>
          <label htmlFor="pos-email" className="block text-sm font-medium text-gray-700 mb-1.5">
            Patient email
          </label>
          <input
            id="pos-email"
            type="email"
            autoComplete="off"
            data-testid="pos-email-input"
            value={patientEmail}
            onChange={(e) => setPatientEmail(e.target.value)}
            placeholder="patient@example.com"
            className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-base text-gray-900"
          />
        </div>
      )}

      {delivery === 'qr' && (
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
      )}

      {emailSentTo && (
        <div
          role="status"
          data-testid="pos-email-sent"
          className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-900"
        >
          Bill emailed to <span className="font-medium">{emailSentTo}</span>.
        </div>
      )}

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
        {delivery === 'email'
          ? (isPending ? 'Sending…' : 'Email the bill')
          : (isPending ? 'Generating QR…' : 'Generate QR')}
      </button>
    </form>
  );
}
