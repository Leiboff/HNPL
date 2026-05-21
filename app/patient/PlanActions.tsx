'use client';

import { useState } from 'react';

type Props = {
  planId: string;
  acceptPlan: (planId: string) => Promise<{ error: string | null }>;
  declinePlan: (planId: string) => Promise<{ error: string | null }>;
};

export default function PlanActions({ planId, acceptPlan, declinePlan }: Props) {
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = accepting || declining;

  async function handleAccept() {
    setError(null);
    setAccepting(true);
    const result = await acceptPlan(planId);
    if (result.error) {
      setError(result.error);
      setAccepting(false);
    } else {
      window.location.reload();
    }
  }

  async function handleDecline() {
    setError(null);
    setDeclining(true);
    const result = await declinePlan(planId);
    if (result.error) {
      setError(result.error);
      setDeclining(false);
    } else {
      window.location.reload();
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={handleAccept}
          disabled={busy}
          className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {accepting ? 'Accepting…' : 'Accept Plan'}
        </button>
        <button
          onClick={handleDecline}
          disabled={busy}
          className="rounded-lg border border-amber-300 bg-white px-4 py-2.5 text-sm font-medium text-amber-800 hover:bg-amber-50 focus:outline-none focus:ring-2 focus:ring-amber-300 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {declining ? 'Declining…' : 'Decline'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
