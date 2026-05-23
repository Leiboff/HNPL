'use client';

import { useState } from 'react';
import { calculateFee } from '@/lib/finance';
import type { CreateBillResult, CreateBillSummary } from './page';

type Props = {
  feePercent: number;
  createBill: (data: {
    patientEmail: string;
    billAmount: number;
    practiceReference?: string;
  }) => Promise<CreateBillResult>;
};

function formatRand(n: number) {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

function SuccessPanel({
  summary,
  feePercent,
  onReset,
}: {
  summary: CreateBillSummary;
  feePercent: number;
  onReset: () => void;
}) {
  return (
    <div className="bg-green-50 border border-green-200 rounded-2xl p-6 space-y-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <svg
            className="w-5 h-5 text-green-600 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h2 className="text-base font-semibold text-green-900">Bill sent successfully</h2>
        </div>
        <div className="text-right shrink-0 space-y-0.5">
          <span className="block text-xs font-mono text-green-700 bg-green-100 rounded px-2 py-0.5">
            {summary.invoiceNumber}
          </span>
          {summary.practiceReference && (
            <span className="block text-xs text-green-600">
              Your ref: {summary.practiceReference}
            </span>
          )}
        </div>
      </div>

      <p className="text-sm text-green-800">
        <span className="font-medium">{summary.patientName}</span> will receive this bill and
        choose their instalment plan when they log in.
      </p>

      <div className="bg-white rounded-xl border border-green-200 px-4 py-3 space-y-1.5 text-sm">
        <div className="flex justify-between text-gray-500">
          <span>Gross</span>
          <span>{formatRand(summary.gross)}</span>
        </div>
        <div className="flex justify-between text-gray-500">
          <span>HNPL fee ({feePercent}%)</span>
          <span>−{formatRand(summary.fee)}</span>
        </div>
        <div className="flex justify-between font-semibold text-gray-900 border-t border-green-100 pt-1.5">
          <span>Net payout to practice</span>
          <span>{formatRand(summary.net)}</span>
        </div>
      </div>

      <button
        onClick={onReset}
        className="text-sm text-green-700 hover:text-green-800 font-medium underline underline-offset-2"
      >
        Create another bill
      </button>
    </div>
  );
}

export default function BillForm({ feePercent, createBill }: Props) {
  const [patientEmail, setPatientEmail] = useState('');
  const [billAmountStr, setBillAmountStr] = useState('');
  const [practiceReference, setPracticeReference] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<CreateBillSummary | null>(null);

  const billAmount = parseFloat(billAmountStr);
  const validAmount = !isNaN(billAmount) && billAmount >= 500 && billAmount <= 50000;
  const preview = validAmount ? calculateFee(billAmount, feePercent) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validAmount) return;

    setError(null);
    setSummary(null);
    setLoading(true);

    const result = await createBill({
      patientEmail: patientEmail.trim(),
      billAmount,
      practiceReference: practiceReference.trim() || undefined,
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
        }}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-6">
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
            onChange={(e) => setPatientEmail(e.target.value)}
            placeholder="patient@example.com"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <p className="mt-1 text-xs text-gray-400">
            The patient must have an HNPL account.
          </p>
        </div>

        {/* Bill amount */}
        <div>
          <label htmlFor="billAmount" className="block text-sm font-medium text-gray-700 mb-1">
            Bill amount
          </label>
          <div className="relative">
            <span className="absolute inset-y-0 left-3 flex items-center text-sm text-gray-500 pointer-events-none">
              R
            </span>
            <input
              id="billAmount"
              type="number"
              required
              min={500}
              max={50000}
              step="0.01"
              value={billAmountStr}
              onChange={(e) => setBillAmountStr(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg border border-gray-300 pl-7 pr-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <p className="mt-1 text-xs text-gray-400">Between R500 and R50 000</p>
        </div>

        {/* Practice reference (optional) */}
        <div>
          <label htmlFor="practiceReference" className="block text-sm font-medium text-gray-700 mb-1">
            Your reference <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
            id="practiceReference"
            type="text"
            value={practiceReference}
            onChange={(e) => setPracticeReference(e.target.value)}
            placeholder="e.g. INV-4471"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <p className="mt-1 text-xs text-gray-400">
            If you have your own invoice number, enter it here. We'll also generate an HNPL reference for tracking.
          </p>
        </div>
      </div>

      {/* Live preview */}
      {preview && (
        <div className="bg-gray-50 rounded-2xl border border-gray-200 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Payout preview</h3>

          <div className="space-y-1.5">
            <div className="flex justify-between text-sm text-gray-500">
              <span>Gross</span>
              <span>{formatRand(preview.gross)}</span>
            </div>
            <div className="flex justify-between text-sm text-gray-500">
              <span>HNPL fee ({feePercent}%)</span>
              <span>−{formatRand(preview.fee)}</span>
            </div>
            <div className="flex justify-between text-sm font-semibold text-gray-900 border-t border-gray-200 pt-1.5">
              <span>Net payout to you</span>
              <span>{formatRand(preview.net)}</span>
            </div>
          </div>

          <p className="text-xs text-gray-400 border-t border-gray-200 pt-3">
            Your patient will choose how many instalments to split this into when they accept.
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={loading || !validAmount || !patientEmail.trim()}
        className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? 'Sending bill…' : 'Send bill to patient'}
      </button>
    </form>
  );
}
