'use client';

import { useState } from 'react';
import { calculateFee } from '@/lib/finance';
import type { CreateBillResult, CreateBillSummary, ProviderOption } from './page';

type Props = {
  feePercent: number;
  providers:  ProviderOption[];
  createBill: (data: {
    patientEmail:      string;
    billAmount:        number;
    practiceReference?: string;
    providerId:        string;
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
  const isInvite       = !!summary.invitation;
  const isExisting     = !!summary.existingAccount;
  const inviteDelivery   = summary.invitation?.emailDelivery;
  const existingDelivery = summary.existingAccount?.emailDelivery;
  const emailFailed = (isInvite   && inviteDelivery   && !inviteDelivery.sent)
                    || (isExisting && existingDelivery && !existingDelivery.sent);

  const tone = emailFailed ? 'red' : isInvite ? 'blue' : 'green';
  const wrap = tone === 'red'   ? 'bg-red-50 border-red-200'
            : tone === 'blue'   ? 'bg-blue-50 border-blue-200'
            :                     'bg-green-50 border-green-200';
  const headingCls = tone === 'red'   ? 'text-red-900'
                   : tone === 'blue'   ? 'text-blue-900'
                   :                     'text-green-900';
  const iconCls    = tone === 'red'   ? 'text-red-600'
                   : tone === 'blue'   ? 'text-blue-600'
                   :                     'text-green-600';
  const chipCls    = tone === 'red'   ? 'bg-red-100 text-red-700'
                   : tone === 'blue'   ? 'bg-blue-100 text-blue-700'
                   :                     'bg-green-100 text-green-700';
  const innerCls   = tone === 'red'   ? 'bg-white border-red-200'
                   : tone === 'blue'   ? 'bg-white border-blue-200'
                   :                     'bg-white border-green-200';

  const heading =
    emailFailed         ? 'Bill created, but the email failed'
    : isInvite          ? 'Invitation emailed to patient'
    :                     'Bill sent to patient';

  return (
    <div className={`border rounded-2xl p-6 space-y-5 ${wrap}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <svg
            className={`w-5 h-5 shrink-0 ${iconCls}`}
            fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round"
              d={emailFailed
                ? 'M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z'
                : isInvite
                  ? 'M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75'
                  : 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z'}
            />
          </svg>
          <h2 className={`text-base font-semibold ${headingCls}`}>
            {heading}
          </h2>
        </div>
        <span className={`font-mono text-xs rounded px-2 py-0.5 shrink-0 ${chipCls}`}>
          {summary.invoiceNumber}
        </span>
      </div>

      {/* Body — driven by the three states */}
      {emailFailed && (isInvite ? inviteDelivery : existingDelivery) && (
        <div className={`rounded-xl border p-4 space-y-2 ${innerCls}`}>
          <p className="text-sm font-medium text-gray-900">
            We couldn&apos;t email {' '}
            <span className="font-semibold">
              {(isInvite ? inviteDelivery : existingDelivery)!.to}
            </span>
          </p>
          <p className="text-xs text-red-700">
            {(isInvite ? inviteDelivery : existingDelivery)!.error ?? 'Email service error.'}
          </p>
          <p className="text-xs text-gray-600 mt-2">
            {isInvite
              ? 'The patient cannot reach checkout until this email is delivered. Double-check the address and create the bill again.'
              : 'The bill is on the patient\'s dashboard, but they may not realise it\'s there. Reach out to them directly, or correct the email and re-send.'}
          </p>
        </div>
      )}

      {!emailFailed && isInvite && summary.invitation && (
        <div className={`rounded-xl border p-4 space-y-1 ${innerCls}`}>
          <p className="text-sm text-gray-900">
            We&apos;ve emailed the checkout link to{' '}
            <span className="font-semibold">{summary.invitation.email}</span>.
          </p>
          <p className="text-xs text-gray-500">
            Link is valid for 7 days (expires {formatDate(summary.invitation.expiresAt)}).
            The patient reviews the bill, picks 2 or 3 instalments, and pays — all on one screen.
          </p>
        </div>
      )}

      {!emailFailed && isExisting && summary.existingAccount && (
        <div className={`rounded-xl border p-4 space-y-1 ${innerCls}`}>
          <p className="text-sm text-gray-900">
            <span className="font-semibold">{summary.patientName}</span> already has a BetterNow account.
            The bill is on their dashboard.
          </p>
          <p className="text-xs text-gray-500">
            We&apos;ve emailed{' '}
            <span className="font-mono">{summary.existingAccount.email}</span> a nudge to log in and review.
          </p>
        </div>
      )}

      <div className={`rounded-xl border px-4 py-3 space-y-1.5 text-sm bg-white ${innerCls.replace('bg-white ', '')}`}>
        <div className="flex justify-between text-gray-500">
          <span>Gross</span>
          <span>{formatRand(summary.gross)}</span>
        </div>
        <div className="flex justify-between text-gray-500">
          <span>BetterNow fee ({feePercent}%)</span>
          <span>−{formatRand(summary.fee)}</span>
        </div>
        <div className="flex justify-between font-semibold text-gray-900 border-t border-gray-100 pt-1.5">
          <span>Net payout to practice</span>
          <span>{formatRand(summary.net)}</span>
        </div>
      </div>

      <button
        onClick={onReset}
        className={`text-sm font-medium underline underline-offset-2 ${
          tone === 'red'   ? 'text-red-700 hover:text-red-800'
          : tone === 'blue'  ? 'text-blue-700 hover:text-blue-800'
          :                    'text-green-700 hover:text-green-800'
        }`}
      >
        Create another bill
      </button>
    </div>
  );
}

export default function BillForm({ feePercent, providers, createBill }: Props) {
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

    const result = await createBill({
      patientEmail:     patientEmail.trim(),
      billAmount,
      practiceReference: practiceReference.trim() || undefined,
      providerId,
    });

    if (result.error) {
      setError(result.error);
    } else if (result.summary) {
      setSummary(result.summary);
    }
    setLoading(false);
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
