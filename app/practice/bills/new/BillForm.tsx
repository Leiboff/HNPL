'use client';

import { useState } from 'react';
import { splitInstalments, calculateFee } from '@/lib/finance';
import type { CreateBillResult, CreateBillSummary } from './page';

type Props = {
  feePercent: number;
  createBill: (data: {
    patientEmail: string;
    billAmount: number;
    planType: 2 | 3;
  }) => Promise<CreateBillResult>;
};

const DATE_LABELS = ['Today', "Patient's salary date", 'Following salary date'];

function formatRand(n: number) {
  return `R${n.toFixed(2)}`;
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
        <h2 className="text-base font-semibold text-green-900">Plan created successfully</h2>
      </div>

      <div className="text-sm text-green-800 space-y-0.5">
        <p>
          <span className="font-medium">Patient:</span> {summary.patientName}
        </p>
        <p>
          <span className="font-medium">Plan:</span> {summary.instalments.length} instalments
        </p>
      </div>

      <div className="bg-white rounded-xl border border-green-200 divide-y divide-green-100 overflow-hidden">
        {summary.instalments.map((amt, i) => (
          <div key={i} className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="text-gray-600">
              Instalment {i + 1}
              <span className="ml-2 text-xs text-gray-400">{summary.dueDates[i]}</span>
            </span>
            <span className="font-medium text-gray-900">{formatRand(amt)}</span>
          </div>
        ))}
      </div>

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
  const [planType, setPlanType] = useState<2 | 3>(2);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<CreateBillSummary | null>(null);

  const billAmount = parseFloat(billAmountStr);
  const validAmount = !isNaN(billAmount) && billAmount >= 500 && billAmount <= 50000;

  const preview = validAmount
    ? {
        instalments: splitInstalments(billAmount, planType),
        fee: calculateFee(billAmount, feePercent),
      }
    : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validAmount) return;

    setError(null);
    setSummary(null);
    setLoading(true);

    const result = await createBill({
      patientEmail: patientEmail.trim(),
      billAmount,
      planType,
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
          setPlanType(2);
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
            The patient must have signed up and set their salary date first.
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

        {/* Plan type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Number of instalments
          </label>
          <div className="grid grid-cols-2 gap-3">
            {([2, 3] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setPlanType(n)}
                className={`rounded-xl border-2 px-4 py-3 text-sm font-medium transition-colors ${
                  planType === n
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                }`}
              >
                {n} instalments
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Live preview */}
      {preview && (
        <div className="bg-gray-50 rounded-2xl border border-gray-200 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Preview</h3>

          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
              Payment schedule
            </p>
            {preview.instalments.map((amt, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-600">
                  Instalment {i + 1}
                  <span className="ml-2 text-xs text-gray-400 italic">{DATE_LABELS[i]}</span>
                </span>
                <span className="font-medium text-gray-900">{formatRand(amt)}</span>
              </div>
            ))}
          </div>

          <div className="border-t border-gray-200 pt-4 space-y-1.5">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
              Practice payout
            </p>
            <div className="flex justify-between text-sm text-gray-500">
              <span>Gross</span>
              <span>{formatRand(preview.fee.gross)}</span>
            </div>
            <div className="flex justify-between text-sm text-gray-500">
              <span>HNPL fee ({feePercent}%)</span>
              <span>−{formatRand(preview.fee.fee)}</span>
            </div>
            <div className="flex justify-between text-sm font-semibold text-gray-900 border-t border-gray-200 pt-1.5">
              <span>Net payout</span>
              <span>{formatRand(preview.fee.net)}</span>
            </div>
          </div>
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
        {loading ? 'Creating plan…' : 'Create payment plan'}
      </button>
    </form>
  );
}
