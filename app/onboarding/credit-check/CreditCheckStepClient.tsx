'use client';

import { useState } from 'react';
import { runCreditCheck } from '@/lib/onboarding/actions';

// ─── Credit-check step (client) — INTEGRATION SEAM ─────────────────────
//
// Placeholder UI for the affordability check step. Renders a "Run
// check" button that calls the runCreditCheck() server action —
// currently a stub that marks the check as 'passed'. The real
// integration (credit bureau + affordability computation) will
// replace runCreditCheck's body without touching this UI.
//
// If ENABLE_CREDIT_CHECK is off, the parent page redirects out before
// this component ever mounts.

export default function CreditCheckStepClient() {
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleRun() {
    setError(null);
    setLoading(true);
    const result = await runCreditCheck();
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    window.location.href = result.nextPath ?? '/onboarding';
  }

  return (
    <div className="flex flex-1 flex-col" data-testid="onboarding-credit-check-stub">
      <p className="text-[14px] leading-[1.65]" style={{ color: '#41556F' }}>
        Tap to run a quick affordability check. Your result stays with BetterNow — no lender is contacted without your explicit consent.
      </p>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleRun}
        disabled={loading}
        data-testid="onboarding-credit-check-run"
        className="mt-auto flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all disabled:opacity-45 disabled:cursor-not-allowed"
        style={{ background: '#15A89E', boxShadow: loading ? 'none' : '0 10px 22px -12px rgba(21,168,158,0.9)' }}
      >
        {loading ? 'Assessing…' : 'Run check'}
      </button>
    </div>
  );
}
