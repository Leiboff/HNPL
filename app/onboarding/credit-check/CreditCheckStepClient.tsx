'use client';

import { useState } from 'react';
import { runCreditCheck } from '@/lib/onboarding/actions';
import {
  AUTH_PRIMARY_CLS,
  AUTH_ERROR_CLS,
  AUTH_SUBTITLE_CLS,
  authPrimaryStyle,
} from '@/app/_components/authFormStyles';

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
      <p className={AUTH_SUBTITLE_CLS}>
        Tap to run a quick affordability check. Your result stays with BetterNow — no lender is contacted without your explicit consent.
      </p>

      {error && (
        <p className={`mt-4 ${AUTH_ERROR_CLS}`} role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleRun}
        disabled={loading}
        data-testid="onboarding-credit-check-run"
        className={`mt-auto ${AUTH_PRIMARY_CLS}`}
        style={authPrimaryStyle(loading)}
      >
        {loading ? 'Assessing…' : 'Run check'}
      </button>
    </div>
  );
}
