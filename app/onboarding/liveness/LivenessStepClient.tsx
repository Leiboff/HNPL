'use client';

import { useState } from 'react';
import { runLiveness } from '@/lib/onboarding/actions';

// ─── Liveness step (client) — INTEGRATION SEAM ─────────────────────────
//
// Placeholder UI. Real integration (face-camera vendor) will replace
// this component's body — the runLiveness() server action's body — and
// the route + state model keep working without changes.

export default function LivenessStepClient() {
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleRun() {
    setError(null);
    setLoading(true);
    const result = await runLiveness();
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    window.location.href = result.nextPath ?? '/onboarding';
  }

  return (
    <div className="space-y-4" data-testid="onboarding-liveness-stub">
      <p className="text-sm text-gray-600">
        Tap when you&apos;re ready. We&apos;ll ask for camera access and guide you through a brief check.
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
        data-testid="onboarding-liveness-run"
        className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {loading ? 'Verifying…' : 'Start face check'}
      </button>
    </div>
  );
}
