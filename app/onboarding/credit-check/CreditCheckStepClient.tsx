'use client';

import { useState } from 'react';
import { runCreditCheck } from '@/lib/onboarding/actions';
import {
  AUTH_PRIMARY_CLS,
  AUTH_ERROR_CLS,
  AUTH_SUBTITLE_CLS,
  authPrimaryStyle,
} from '@/app/_components/authFormStyles';

// ─── Credit-check step (client) ────────────────────────────────────────
//
// Runs the affordability enquiry and prices the standing limit. The score
// gate already ran at the identity step, so a patient who reaches this
// screen has passed it.
//
// ─── PENDING IS NOT AN ERROR, AND MUST NOT LOOK LIKE ONE ───────────────
//
// Two failure shapes reach this component and they are shown differently:
//
//   • a DECLINE, or a genuine input problem — the red error treatment
//   • PENDING, meaning we could not reach the bureau — a neutral "try
//     again in a moment" note with the button still available
//
// The distinction is not cosmetic. A patient we could not assess has not
// been refused, is not in the decline cooldown, and will get a different
// answer if they tap again in a minute. Rendering that in the same red
// box as a refusal tells them something untrue about their application at
// the exact moment they are most likely to believe it.

export default function CreditCheckStepClient() {
  const [error,   setError]   = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleRun() {
    setError(null);
    setPending(null);
    setLoading(true);
    const result = await runCreditCheck();
    setLoading(false);

    if (result.error) {
      if (result.pending) setPending(result.error);
      else                setError(result.error);
      return;
    }
    window.location.href = result.nextPath ?? '/onboarding';
  }

  return (
    <div className="flex flex-1 flex-col" data-testid="onboarding-credit-check">
      <p className={AUTH_SUBTITLE_CLS}>
        We&rsquo;ll check what you can comfortably afford and set your limit.
        This takes a few seconds.
      </p>

      {error && (
        <p className={`mt-4 ${AUTH_ERROR_CLS}`} role="alert" data-testid="credit-check-error">
          {error}
        </p>
      )}

      {pending && (
        // Deliberately NOT AUTH_ERROR_CLS, and deliberately role="status"
        // rather than role="alert": this is progress information, not a
        // decision. Screen readers announce it politely for the same
        // reason the colour is neutral.
        <p
          className="mt-4 rounded-xl px-4 py-3 text-[13px] leading-[1.5]"
          style={{
            background: 'rgba(19,41,75,.05)',
            border:     '1px solid rgba(19,41,75,.15)',
            color:      'var(--brand-navy)',
          }}
          role="status"
          data-testid="credit-check-pending"
        >
          {pending}
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
        {loading ? 'Checking…' : pending ? 'Try again' : 'Run check'}
      </button>
    </div>
  );
}
