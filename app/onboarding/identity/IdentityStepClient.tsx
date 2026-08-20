'use client';

import { useState } from 'react';
import SalaryDayPicker from '@/components/SalaryDayPicker';
import { ShieldIcon } from '@/app/_landing/icons';
import { saveIdAndSalaryDay } from '@/lib/onboarding/actions';
import { validateSaId, saIdAge } from '@/lib/validation';
import { isValidSalaryAmount } from '@/lib/salaryAmount';

// ─── Identity step (client) ────────────────────────────────────────────
//
// Client-side validation is a UX layer only — the server action
// re-validates + encrypts. We keep the same "generic single-message"
// rule the signup form uses: don't leak which sub-check failed.

const SA_ID_GENERIC_ERROR = 'Please enter a valid SA ID number.';
const MIN_AGE = 18;

const INPUT_CLS =
  'h-[56px] w-full rounded-[14px] border-[1.5px] border-[#E2E8EE] bg-[#FBFCFD] px-4 text-[16px] tracking-[0.06em] ' +
  'text-[#13294B] outline-none transition-colors placeholder:text-[#A8B4C2] ' +
  'focus:border-[#15A89E] focus:bg-white focus:ring-4 focus:ring-[#15A89E]/15';

export default function IdentityStepClient() {
  const [saId,          setSaId]          = useState('');
  const [salaryDay,     setSalaryDay]     = useState<number | null>(null);
  const [salaryAmount,  setSalaryAmount]  = useState('');
  const [error,         setError]         = useState<string | null>(null);
  const [loading,       setLoading]       = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const cleaned = saId.replace(/\s+/g, '');
    const check = validateSaId(cleaned);
    if (!check.valid) {
      setError(SA_ID_GENERIC_ERROR);
      return;
    }
    const age = saIdAge(cleaned);
    if (age === null || age < MIN_AGE) {
      setError(`You must be ${MIN_AGE} or older to use BetterNow.`);
      return;
    }
    if (salaryDay === null) {
      setError('Please choose when your salary is paid.');
      return;
    }

    const amount = Number(salaryAmount);
    if (!isValidSalaryAmount(amount)) {
      setError('Please enter how much you earn a month.');
      return;
    }

    setLoading(true);
    const result = await saveIdAndSalaryDay({ saIdNumber: cleaned, salaryDay, salaryAmount: amount });
    setLoading(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    window.location.href = result.nextPath ?? '/onboarding';
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="sa-id" className="text-[13px] font-medium" style={{ color: '#41556F' }}>
          South African ID number
        </label>
        <input
          id="sa-id"
          type="text"
          inputMode="numeric"
          maxLength={13}
          autoComplete="off"
          value={saId}
          onChange={(e) => setSaId(e.target.value.replace(/\D/g, ''))}
          data-testid="onboarding-sa-id"
          placeholder="13-digit ID number"
          className={INPUT_CLS}
        />
        <div className="flex items-start gap-2">
          <span className="mt-px inline-flex shrink-0" style={{ color: '#15A89E' }} aria-hidden="true">
            <ShieldIcon size={16} />
          </span>
          <p className="text-[12px] leading-[1.5]" style={{ color: '#8496AA' }}>
            Stored encrypted. We use it for the affordability check and to verify it&apos;s really you.
          </p>
        </div>
      </div>

      <SalaryDayPicker
        value={salaryDay}
        onChange={(d) => setSalaryDay(d)}
      />

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
            className="h-[56px] w-full rounded-[14px] border-[1.5px] border-[#E2E8EE] bg-[#FBFCFD] pl-8 pr-4 text-[16px] text-[#13294B] outline-none transition-colors placeholder:text-[#A8B4C2] focus:border-[#15A89E] focus:bg-white focus:ring-4 focus:ring-[#15A89E]/15"
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
        disabled={loading}
        data-testid="onboarding-identity-submit"
        className="mt-auto flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all disabled:opacity-45 disabled:cursor-not-allowed"
        style={{ background: '#15A89E', boxShadow: loading ? 'none' : '0 10px 22px -12px rgba(21,168,158,0.9)' }}
      >
        {loading ? 'Saving…' : 'Continue'}
      </button>
    </form>
  );
}
