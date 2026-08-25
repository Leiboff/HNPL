'use client';

import { useState } from 'react';
import SalaryDayPicker from '@/components/SalaryDayPicker';
import { saveSalaryDetails } from '@/lib/onboarding/actions';
import { isValidSalaryAmount } from '@/lib/salaryAmount';
import { INPUT_CLS, BUTTON_CLS } from '@/app/onboarding/formStyles';

// ─── Salary step (client) ──────────────────────────────────────────────
//
// Split out of the old combined identity+salary step. It was always two
// independent forms with two independent submits sharing one page, which
// meant one screen asked for a government ID, biometric consent, a pay
// date and an income figure at once — and a single "Step 2 of 2" label
// covering all of it.
//
// This half is a plain synchronous form: save the two values, move on.
// It runs BEFORE identity because identity ends by redirecting off-site
// to Didit and resolving via webhook; a form placed after it would have
// to be returned to.
//
// Credit-check SEAM (unchanged): saveSalaryDetails' server code
// auto-passes the credit check when ENABLE_CREDIT_CHECK is off. The
// nextPath it returns is authoritative for where the patient goes next —
// this component never hardcodes the following step.

type Props = {
  salaryDay:    number | null;
  salaryAmount: number | null;
};

export default function SalaryStepClient({
  salaryDay:    initialSalaryDay,
  salaryAmount: initialSalaryAmount,
}: Props) {
  const [salaryDay,    setSalaryDay]    = useState<number | null>(initialSalaryDay);
  const [salaryAmount, setSalaryAmount] = useState(initialSalaryAmount != null ? String(initialSalaryAmount) : '');
  const [error,        setError]        = useState<string | null>(null);
  const [saving,       setSaving]       = useState(false);

  const alreadySaved = initialSalaryDay != null && initialSalaryAmount != null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (salaryDay === null) {
      setError('Please choose when your salary is paid.');
      return;
    }
    const amount = Number(salaryAmount);
    if (!isValidSalaryAmount(amount)) {
      setError('Please enter how much you earn a month.');
      return;
    }

    setSaving(true);
    const result = await saveSalaryDetails({ salaryDay, salaryAmount: amount });
    setSaving(false);

    if (result.error !== null) {
      setError(result.error);
      return;
    }

    // The server decides what comes next — it knows whether the credit
    // check is enabled and whether it auto-passed. Always follow it.
    window.location.href = result.nextPath;
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-1 flex-col gap-6"
      data-testid="onboarding-salary-form"
    >
      <SalaryDayPicker value={salaryDay} onChange={(d) => setSalaryDay(d)} />

      <div className="flex flex-col gap-2">
        <label htmlFor="salary-amount" className="text-[13px] font-medium" style={{ color: '#41556F' }}>
          Monthly income
        </label>
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[16px]"
            style={{ color: '#A8B4C2' }}
          >
            R
          </span>
          <input
            id="salary-amount"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            autoComplete="off"
            value={salaryAmount}
            onChange={(e) => setSalaryAmount(e.target.value)}
            data-testid="onboarding-salary-amount"
            placeholder="15,000"
            className={INPUT_CLS + ' pl-8'}
          />
        </div>
        <p className="text-[12px] leading-[1.5]" style={{ color: '#8496AA' }}>
          What you take home a month, before any instalments. Used for the affordability check.
        </p>
      </div>

      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={saving}
        data-testid="onboarding-salary-submit"
        className={BUTTON_CLS}
        style={{
          background: '#15A89E',
          boxShadow: saving ? 'none' : '0 10px 22px -12px rgba(21,168,158,0.9)',
        }}
      >
        {saving ? 'Saving…' : alreadySaved ? 'Continue' : 'Continue'}
      </button>
    </form>
  );
}
