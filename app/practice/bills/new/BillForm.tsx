'use client';

import { useState } from 'react';
import { calculateFee } from '@/lib/finance';
import { isValidEmail } from '@/lib/validation/email';
import {
  isAllowedBillAmount,
  MIN_BILL_AMOUNT,
  MAX_BILL_AMOUNT,
  formatRandLimit,
} from '@/lib/config/billAmountLimits';
import type { CreateBillResult, CreateBillSummary, ProviderOption } from './page';
import BillWaitingPanel from './BillWaitingPanel';
import { formatRand } from '../../billHelpers';

type Props = {
  feePercent: number;
  providers:  ProviderOption[];
  /**
   * The practice this form is scoped to. Threaded from the page's
   * ?practiceId= resolution so the server-side createBill runs against
   * the correct branch when the caller is a multi-membership user
   * (brand-admin with N≥2 branches). See app/practice/bills/new/page.tsx
   * + app/practice/bills/new/actions.ts for the resolution chain.
   */
  practiceId: string;
  createBill: (data: {
    patientEmail:      string;
    billAmount:        number;
    practiceReference?: string;
    providerMemberId:  string;
    practiceId:        string;
  }) => Promise<CreateBillResult>;
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ─── Success panel ─────────────────────────────────────────────────────────
//
// Three states, driven by the createBill response shape:
//
//   1. Existing patient — bill is on their dashboard; we sent a
//      "log in to view" email. No checkout link is involved.
//   2. New patient + email sent — invitation row created, checkout
//      link sent to their email. The link is NEVER shown here.
//   3. New patient + email FAILED — the invitation row exists but
//      the patient has no way to reach it. We surface the failure
//      so the provider can correct the email and resend.

function SuccessPanel({
  summary,
  feePercent,
  onReset,
  dashboardHref,
}: {
  summary: CreateBillSummary;
  feePercent: number;
  onReset: () => void;
  /** Practice-scoped dashboard URL, same ?practiceId= shape the page header uses. */
  dashboardHref: string;
}) {
  const isInvite         = !!summary.invitation;
  const isExisting       = !!summary.existingAccount;
  const inviteDelivery   = summary.invitation?.emailDelivery;
  const existingDelivery = summary.existingAccount?.emailDelivery;
  const emailFailed = (isInvite   && inviteDelivery   && !inviteDelivery.sent)
                    || (isExisting && existingDelivery && !existingDelivery.sent);

  const heading =
    emailFailed         ? 'Bill created, but the email failed'
    : isInvite          ? 'Invitation emailed'
    :                     'Bill sent';

  return (
    <div className="space-y-4">
      {/* ── Heading row ───────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 px-1">
        <h2 className="text-2xl font-semibold tracking-[-0.01em] text-[#0F1F3A]">
          {heading}
        </h2>
        <span className="font-mono text-[11px] rounded-full bg-[#FAFBFD] border border-[#E5E9F0] px-2.5 py-1 text-[#3A4B66] shrink-0">
          {summary.invoiceNumber}
        </span>
      </div>

      {/* ── Email failure callout (only when applicable) ─────────── */}
      {emailFailed && (isInvite ? inviteDelivery : existingDelivery) && (
        <div className="rounded-[20px] border border-[#E07A7A] bg-[#FCEAEA] p-5 space-y-1.5">
          <p className="text-sm font-medium text-[#0F1F3A]">
            We couldn&apos;t email{' '}
            <span className="font-semibold">
              {(isInvite ? inviteDelivery : existingDelivery)!.to}
            </span>
          </p>
          <p className="text-xs text-[#8A1F1F]">
            {(isInvite ? inviteDelivery : existingDelivery)!.error ?? 'Email service error.'}
          </p>
          <p className="text-xs text-[#3A4B66] pt-1">
            {isInvite
              ? 'The patient cannot reach checkout until this email is delivered. Check the address and re-send.'
              : 'The bill is on the patient\'s dashboard. Reach out directly, or correct the email and re-send.'}
          </p>
        </div>
      )}

      {/* ── Delivery confirmation (sent OK) ──────────────────────── */}
      {!emailFailed && isInvite && summary.invitation && (
        <p className="text-sm text-[#3A4B66] px-1">
          Checkout link sent to{' '}
          <span className="font-medium text-[#0F1F3A]">{summary.invitation.email}</span>.{' '}
          <span className="text-[#7A8AA0]">Valid until {formatDate(summary.invitation.expiresAt)}.</span>
        </p>
      )}
      {!emailFailed && isExisting && summary.existingAccount && (
        <p className="text-sm text-[#3A4B66] px-1">
          <span className="font-medium text-[#0F1F3A]">{summary.patientName}</span> already has an account — the bill is on their dashboard, and we&apos;ve nudged them by email.
        </p>
      )}

      {/* ── The moment that matters — live waiting panel ─────────── */}
      {/* Renders only when we have a planId to subscribe to AND the
          outbound email went out (otherwise the patient has no way
          to reach checkout, so "waiting" would be misleading). */}
      {!emailFailed && summary.planId && (
        <BillWaitingPanel
          planId={summary.planId}
          invitationId={summary.invitation?.invitationId}
          patientLabel={summary.patientName}
          amount={summary.gross}
          initial={{
            planStatus:           'pending_acceptance',
            invitationViewedAt:   null,
            invitationAcceptedAt: null,
            invitationExpiresAt:  summary.invitation?.expiresAt ?? null,
          }}
        />
      )}

      {/* ── Payout breakdown ─────────────────────────────────────────
          Three lines: Gross / Fee / Net. Net is the line that
          matters to the practice; we let it carry visual weight
          via type size + a divider above. Smaller text + softer
          colours than the headline numbers above. */}
      <div className="rounded-[20px] border border-[#E5E9F0] bg-white p-5 sm:p-6">
        <p className="text-xs uppercase tracking-[0.08em] font-medium text-[#7A8AA0] mb-3">
          Payout
        </p>
        <dl className="space-y-2 text-sm">
          <div className="flex items-baseline justify-between">
            <dt className="text-[#3A4B66]">Gross</dt>
            <dd className="tabular-nums text-[#3A4B66]">{formatRand(summary.gross)}</dd>
          </div>
          <div className="flex items-baseline justify-between">
            <dt className="text-[#3A4B66]">BetterNow fee · {feePercent}%</dt>
            <dd className="tabular-nums text-[#3A4B66]">−{formatRand(summary.fee)}</dd>
          </div>
          <div className="pt-3 mt-1 border-t border-[#E5E9F0] flex items-baseline justify-between">
            <dt className="text-[15px] font-medium text-[#0F1F3A]">Net to practice</dt>
            <dd className="text-xl font-semibold tabular-nums text-[#0F1F3A]">{formatRand(summary.net)}</dd>
          </div>
        </dl>
      </div>

      {/* ── Exits ─────────────────────────────────────────────────────
          The page shell does have a "← Back to dashboard" link, but it
          sits in a NON-sticky header and this panel is tall (waiting
          panel + payout breakdown), so on a phone the only visible
          action after creating a bill was "Create another bill". Both
          exits now live together at the end of the panel, reachable in
          one click without scrolling back up. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <button
          onClick={onReset}
          data-testid="create-another-bill"
          className="text-sm font-medium text-[#13294B] hover:text-[#0F1F3A] focus:outline-none focus-visible:underline transition-colors"
        >
          Create another bill →
        </button>
        <a
          href={dashboardHref}
          data-testid="back-to-dashboard"
          className="text-sm font-medium text-[#3A4B66] hover:text-[#0F1F3A] focus:outline-none focus-visible:underline transition-colors"
        >
          ← Back to dashboard
        </a>
      </div>
    </div>
  );
}

export default function BillForm({ feePercent, providers, practiceId, createBill }: Props) {
  const [patientEmail,     setPatientEmail]     = useState('');
  const [billAmountStr,    setBillAmountStr]    = useState('');
  const [practiceReference, setPracticeReference] = useState('');
  const [providerMemberId, setProviderMemberId] = useState(providers.length === 1 ? providers[0].memberId : '');
  const [loading,          setLoading]          = useState(false);
  const [error,            setError]            = useState<string | null>(null);
  const [summary,          setSummary]          = useState<CreateBillSummary | null>(null);
  // Per-field validation messages, surfaced next to the field they
  // belong to. Plain state (not an array) so a repeated submit on the
  // same invalid data overwrites rather than stacking duplicates.
  const [amountError,      setAmountError]      = useState<string | null>(null);
  const [emailError,       setEmailError]       = useState<string | null>(null);
  const [providerError,    setProviderError]    = useState<string | null>(null);

  const billAmount = parseFloat(billAmountStr);
  const validAmount = isAllowedBillAmount(billAmount);
  const preview = validAmount ? calculateFee(billAmount, feePercent) : null;

  const AMOUNT_RANGE_MESSAGE =
    `Enter an amount between ${formatRandLimit(MIN_BILL_AMOUNT)} and ${formatRandLimit(MAX_BILL_AMOUNT)}.`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Validate EVERY field up front and surface a specific message next
    // to each offender. This used to be `if (!validAmount) return;` — a
    // bare early return that set no state at all, so an out-of-range
    // amount produced a completely silent no-op (no error, no request).
    // The submit button was ALSO disabled on the same condition, so the
    // click never even reached this handler. Both halves are fixed: the
    // button now only blocks while a request is in flight, and every
    // rejection path below writes a visible message.
    const trimmedEmail = patientEmail.trim();
    const nextEmailError = !trimmedEmail
      ? 'Enter the patient\'s email address.'
      : !isValidEmail(trimmedEmail)
        ? 'Enter a valid email address, e.g. patient@example.com.'
        : null;
    const nextAmountError = !billAmountStr.trim()
      ? 'Enter a bill amount.'
      : !validAmount
        ? AMOUNT_RANGE_MESSAGE
        : null;
    const nextProviderError = !providerMemberId ? 'Select a healthcare provider.' : null;

    setEmailError(nextEmailError);
    setAmountError(nextAmountError);
    setProviderError(nextProviderError);

    if (nextEmailError || nextAmountError || nextProviderError) {
      // A general banner too, so the reason is apparent even if the
      // offending field is scrolled out of view.
      setError('Please fix the highlighted fields and try again.');
      return;
    }

    setError(null);
    setSummary(null);
    setLoading(true);

    // The try/catch/finally is load-bearing: if the server action
    // ever throws (function timeout, network drop, malformed
    // response) the catch surfaces the error AND the finally ensures
    // the button comes back out of its loading state. Without this,
    // a thrown rejection from `await createBill(...)` would skip
    // setLoading(false) entirely and the button would hang forever
    // even though the server-side work has completed.
    try {
      const result = await createBill({
        patientEmail:     trimmedEmail,
        billAmount,
        practiceReference: practiceReference.trim() || undefined,
        providerMemberId,
        practiceId,
      });

      if (result.error) {
        setError(result.error);
      } else if (result.summary) {
        setSummary(result.summary);
      } else {
        // Defensive: the action returned, but neither error nor
        // summary is set. Treat as unknown — tell the provider not
        // to resubmit blindly; the work may have completed.
        setError(
          'The server responded but didn\'t confirm the bill. Refresh this page and check whether the bill was created before submitting again.',
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `Couldn't reach the server (${err.message}). Refresh this page and check whether the bill was created — do NOT resubmit immediately.`
          : 'Couldn\'t reach the server. Refresh this page and check whether the bill was created — do NOT resubmit immediately.',
      );
    } finally {
      setLoading(false);
    }
  }

  if (summary) {
    return (
      <SuccessPanel
        summary={summary}
        feePercent={feePercent}
        dashboardHref={`/practice?practiceId=${encodeURIComponent(practiceId)}`}
        onReset={() => {
          setSummary(null);
          setPatientEmail('');
          setBillAmountStr('');
          setPracticeReference('');
          setProviderMemberId(providers.length === 1 ? providers[0].memberId : '');
          setError(null);
          setAmountError(null);
          setEmailError(null);
          setProviderError(null);
        }}
      />
    );
  }

  const INPUT = 'w-full rounded-lg border px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1';
  // Error variant is a real visual state on the field itself — the old
  // form only had permanently-gray helper text, which is what made an
  // invalid amount indistinguishable from a valid one.
  const OK_BORDER  = 'border-gray-300 focus:border-blue-500 focus:ring-blue-500';
  const ERR_BORDER = 'border-red-500 bg-red-50 focus:border-red-500 focus:ring-red-500';
  const fieldClass = (hasError: boolean) => `${INPUT} ${hasError ? ERR_BORDER : OK_BORDER}`;
  const FIELD_ERROR = 'mt-1 text-xs font-medium text-red-700';

  return (
    // noValidate: we render our OWN inline messages. Left to the browser,
    // native constraint validation (type="email"/min/max) intercepts submit
    // with a transient bubble and handleSubmit never runs, so the styled
    // per-field errors below would never appear. The attributes stay on the
    // inputs for semantics/assistive tech.
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-6">

        {/* Healthcare provider */}
        <div>
          <label htmlFor="providerId" className="block text-sm font-medium text-gray-700 mb-1">
            Healthcare provider
          </label>
          <select
            id="providerId"
            required
            value={providerMemberId}
            onChange={e => { setProviderMemberId(e.target.value); setProviderError(null); }}
            aria-invalid={!!providerError}
            aria-describedby={providerError ? 'providerId-error' : undefined}
            className={fieldClass(!!providerError)}
          >
            {providers.length !== 1 && <option value="">Select provider…</option>}
            {providers.map(p => (
              <option key={p.memberId} value={p.memberId}>
                {p.name}
              </option>
            ))}
          </select>
          {providerError && (
            <p id="providerId-error" role="alert" data-testid="provider-error" className={FIELD_ERROR}>
              {providerError}
            </p>
          )}
        </div>

        {/* Patient email */}
        <div>
          <label htmlFor="patientEmail" className="block text-sm font-medium text-gray-700 mb-1">
            Patient email
          </label>
          <input
            id="patientEmail"
            type="email"
            required
            value={patientEmail}
            onChange={e => { setPatientEmail(e.target.value); setEmailError(null); }}
            placeholder="patient@example.com"
            aria-invalid={!!emailError}
            aria-describedby={emailError ? 'patientEmail-error' : 'patientEmail-hint'}
            className={fieldClass(!!emailError)}
          />
          {emailError ? (
            <p id="patientEmail-error" role="alert" data-testid="email-error" className={FIELD_ERROR}>
              {emailError}
            </p>
          ) : (
            <p id="patientEmail-hint" className="mt-1 text-xs text-gray-400">
              If the patient doesn&apos;t have an account yet, we&apos;ll send them an invitation link.
            </p>
          )}
        </div>

        {/* Bill amount */}
        <div>
          <label htmlFor="billAmount" className="block text-sm font-medium text-gray-700 mb-1">
            Bill amount
          </label>
          <div className="relative">
            <span className="absolute inset-y-0 left-3 flex items-center text-sm text-gray-500 pointer-events-none">R</span>
            <input
              id="billAmount"
              type="number"
              required
              min={MIN_BILL_AMOUNT}
              max={MAX_BILL_AMOUNT}
              step="0.01"
              value={billAmountStr}
              onChange={e => { setBillAmountStr(e.target.value); setAmountError(null); }}
              placeholder="0.00"
              aria-invalid={!!amountError}
              aria-describedby={amountError ? 'billAmount-error' : 'billAmount-hint'}
              className={`w-full rounded-lg border pl-7 pr-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 ${amountError ? ERR_BORDER : OK_BORDER}`}
            />
          </div>
          {amountError ? (
            <p id="billAmount-error" role="alert" data-testid="amount-error" className={FIELD_ERROR}>
              {amountError}
            </p>
          ) : (
            <p id="billAmount-hint" className="mt-1 text-xs text-gray-400">
              Between {formatRandLimit(MIN_BILL_AMOUNT)} and {formatRandLimit(MAX_BILL_AMOUNT)}
            </p>
          )}
        </div>

        {/* Practice reference */}
        <div>
          <label htmlFor="practiceReference" className="block text-sm font-medium text-gray-700 mb-1">
            Your reference <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
            id="practiceReference"
            type="text"
            value={practiceReference}
            onChange={e => setPracticeReference(e.target.value)}
            placeholder="e.g. INV-4471"
            className={INPUT}
          />
          <p className="mt-1 text-xs text-gray-400">
            If you have your own invoice number, enter it here. We&apos;ll also generate a BetterNow reference for tracking.
          </p>
        </div>
      </div>

      {/* Live preview */}
      {preview && (
        <div className="bg-gray-50 rounded-2xl border border-gray-200 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Payout preview</h3>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm text-gray-500">
              <span>Gross</span><span>{formatRand(preview.gross)}</span>
            </div>
            <div className="flex justify-between text-sm text-gray-500">
              <span>BetterNow fee ({feePercent}%)</span><span>−{formatRand(preview.fee)}</span>
            </div>
            <div className="flex justify-between text-sm font-semibold text-gray-900 border-t border-gray-200 pt-1.5">
              <span>Net payout to you</span><span>{formatRand(preview.net)}</span>
            </div>
          </div>
          <p className="text-xs text-gray-400 border-t border-gray-200 pt-3">
            Your patient will choose how many instalments to split this into when they accept.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Disabled ONLY while a request is in flight. It used to also be
          disabled on `!validAmount || !patientEmail.trim() || !providerMemberId`,
          which is the other half of the reported silent failure: a click on
          invalid data dispatched no event at all, so nothing could explain
          why. Now every click either submits or renders the reasons above. */}
      <button
        type="submit"
        disabled={loading}
        data-testid="submit-bill"
        className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {loading ? 'Sending bill…' : 'Send bill to patient'}
      </button>
    </form>
  );
}
