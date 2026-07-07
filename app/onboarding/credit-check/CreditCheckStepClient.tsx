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
    <div className="space-y-4" data-testid="onboarding-credit-check-stub">
      <p className="text-sm text-gray-600">
        Tap to run a quick affordability check. Your result stays with BetterNow — no lender is contacted without your explicit consent.
      </p>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleRun}
        disabled={loading}
        data-testid="onboarding-credit-check-run"
        className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {loading ? 'Checking…' : 'Run check'}
      </button>
    </div>
  );
}
