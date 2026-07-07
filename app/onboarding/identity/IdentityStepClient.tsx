'use client';

import { useState } from 'react';
import SalaryDayPicker from '@/components/SalaryDayPicker';
import { saveIdAndSalaryDay } from '@/lib/onboarding/actions';
import { validateSaId, saIdAge } from '@/lib/validation';

// ─── Identity step (client) ────────────────────────────────────────────
//
// Client-side validation is a UX layer only — the server action
// re-validates + encrypts. We keep the same "generic single-message"
// rule the signup form uses: don't leak which sub-check failed.

const SA_ID_GENERIC_ERROR = 'Please enter a valid SA ID number.';
const MIN_AGE = 18;

const INPUT_CLS =
  'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none ' +
  'focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20';

export default function IdentityStepClient() {
  const [saId,       setSaId]       = useState('');
  const [salaryDay,  setSalaryDay]  = useState<number | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [loading,    setLoading]    = useState(false);

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

    setLoading(true);
    const result = await saveIdAndSalaryDay({ saIdNumber: cleaned, salaryDay });
    setLoading(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    window.location.href = result.nextPath ?? '/onboarding';
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label htmlFor="sa-id" className="block text-sm font-medium text-gray-700 mb-1">
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
        <p className="mt-1 text-xs text-gray-500">
          Stored encrypted. We use it for the affordability check and to verify it&apos;s really you.
        </p>
      </div>

      <div>
        <SalaryDayPicker
          value={salaryDay}
          onChange={(d) => setSalaryDay(d)}
        />
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        data-testid="onboarding-identity-submit"
        className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {loading ? 'Saving…' : 'Continue'}
      </button>
    </form>
  );
}
