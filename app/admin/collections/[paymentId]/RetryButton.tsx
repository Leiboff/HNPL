'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// ─── Retry-now button ───────────────────────────────────────────────────────
//
// Fires the admin-authorized retryCollection() server action, which
// wraps the shared lib/payments/chargeInstalment helper (atomic claim
// + retry-cap respected). Server-side auth is enforced inside the
// action — this component is presentation only.

type Props = {
  paymentId: string;
  action:    (id: string) => Promise<{ error: string | null; outcome?: string }>;
};

export default function RetryButton({ paymentId, action }: Props) {
  const router = useRouter();
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true); setError(null); setOutcome(null);
    const result = await action(paymentId);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setOutcome(result.outcome ?? 'Charge fired.');
    router.refresh();
  }

  return (
    <div className="flex flex-col items-stretch sm:items-end gap-2 shrink-0">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        data-testid={`retry-${paymentId}`}
        className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {busy ? 'Charging…' : 'Retry now'}
      </button>
      {outcome && (
        <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 max-w-xs">
          {outcome}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 max-w-xs">
          {error}
        </p>
      )}
    </div>
  );
}
