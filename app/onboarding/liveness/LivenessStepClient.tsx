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
    <div className="flex flex-1 flex-col" data-testid="onboarding-liveness-stub">
      <p className="text-[14px] leading-[1.65]" style={{ color: '#41556F' }}>
        Tap when you&apos;re ready. We&apos;ll ask for camera access and guide you through a brief check.
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
        data-testid="onboarding-liveness-run"
        className="mt-auto flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all disabled:opacity-45 disabled:cursor-not-allowed"
        style={{ background: '#15A89E', boxShadow: loading ? 'none' : '0 10px 22px -12px rgba(21,168,158,0.9)' }}
      >
        {loading ? 'Verifying…' : 'Start face check'}
      </button>
    </div>
  );
}
