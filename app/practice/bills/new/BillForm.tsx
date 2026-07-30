'use client';

import { useState } from 'react';
import { calculateFee } from '@/lib/finance';
import type { CreateBillResult, CreateBillSummary, ProviderOption } from './page';
import BillWaitingPanel from './BillWaitingPanel';

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
    providerId:        string;
    practiceId:        string;
  }) => Promise<CreateBillResult>;
};

function formatRand(n: number) {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

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
}: {
  summary: CreateBillSummary;
  feePercent: number;
  onReset: () => void;
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

      <button
        onClick={onReset}
        className="text-sm font-medium text-[#13294B] hover:text-[#0F1F3A] focus:outline-none focus-visible:underline transition-colors"
      >
        Create another bill →
      </button>
    </div>
  );
}

export default function BillForm({ feePercent, providers, practiceId, createBill }: Props) {
  const [patientEmail,     setPatientEmail]     = useState('');
  const [billAmountStr,    setBillAmountStr]    = useState('');
  const [practiceReference, setPracticeReference] = useState('');
  const [providerId,       setProviderId]       = useState(providers.length === 1 ? providers[0].userId : '');
  const [loading,          setLoading]          = useState(false);
  const [error,            setError]            = useState<string | null>(null);
  const [summary,          setSummary]          = useState<CreateBillSummary | null>(null);

  const billAmount = parseFloat(billAmountStr);
  const validAmount = !isNaN(billAmount) && billAmount >= 500 && billAmount <= 50000;
  const preview = validAmount ? calculateFee(billAmount, feePercent) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validAmount) return;
    if (!providerId) { setError('Please select a healthcare provider.'); return; }

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
        patientEmail:     patientEmail.trim(),
        billAmount,
        practiceReference: practiceReference.trim() || undefined,
        providerId,
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
        onReset={() => {
          setSummary(null);
          setPatientEmail('');
          setBillAmountStr('');
          setPracticeReference('');
          setProviderId(providers.length === 1 ? providers[0].userId : '');
        }}
      />
    );
  }

  const INPUT = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-6">

        {/* Healthcare provider */}
        <div>
          <label htmlFor="providerId" className="block text-sm font-medium text-gray-700 mb-1">
            Healthcare provider
          </label>
          <select
            id="providerId"
            required
            value={providerId}
            onChange={e => setProviderId(e.target.value)}
            className={INPUT}
          >
            {providers.length !== 1 && <option value="">Select provider…</option>}
            {providers.map(p => (
              <option key={p.userId} value={p.userId}>
                {p.firstName} {p.lastName}
              </option>
            ))}
          </select>
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
            onChange={e => setPatientEmail(e.target.value)}
            placeholder="patient@example.com"
            className={INPUT}
          />
          <p className="mt-1 text-xs text-gray-400">
            If the patient doesn&apos;t have an account yet, we&apos;ll send them an invitation link.
          </p>
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
              min={500}
              max={50000}
              step="0.01"
              value={billAmountStr}
              onChange={e => setBillAmountStr(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg border border-gray-300 pl-7 pr-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <p className="mt-1 text-xs text-gray-400">Between R500 and R50 000</p>
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

      <button
        type="submit"
        disabled={loading || !validAmount || !patientEmail.trim() || !providerId}
        className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {loading ? 'Sending bill…' : 'Send bill to patient'}
      </button>
    </form>
  );
}
