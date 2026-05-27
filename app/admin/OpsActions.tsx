'use client';

import { useState } from 'react';

// ─── Single-action button ─────────────────────────────────────────────────────

type ActionButtonProps = {
  label: string;
  loadingLabel?: string;
  id: string;
  action: (id: string) => Promise<{ error: string | null }>;
  variant?: 'green' | 'red' | 'blue';
};

export function ActionButton({
  label,
  loadingLabel,
  id,
  action,
  variant = 'blue',
}: ActionButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setLoading(true);
    const result = await action(id);
    if (result.error) {
      setError(result.error);
      setLoading(false);
    } else {
      window.location.reload();
    }
  }

  const cls = {
    green: 'bg-green-600 hover:bg-green-700 text-white',
    red:   'bg-red-600   hover:bg-red-700   text-white',
    blue:  'bg-blue-600  hover:bg-blue-700  text-white',
  }[variant];

  return (
    <div className="space-y-1">
      <button
        onClick={handleClick}
        disabled={loading}
        className={`px-2.5 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${cls}`}
      >
        {loading ? (loadingLabel ?? '…') : label}
      </button>
      {error && <p className="text-xs text-red-600 max-w-[180px]">{error}</p>}
    </div>
  );
}

// ─── Charge now + manual override (collections worklist) ─────────────────────

type CollectionActionsProps = {
  paymentId: string;
  chargeInstalment:    (paymentId: string) => Promise<{ error: string | null }>;
  markPaymentCollected:(paymentId: string) => Promise<{ error: string | null }>;
};

export function CollectionActions({
  paymentId,
  chargeInstalment,
  markPaymentCollected,
}: CollectionActionsProps) {
  const [chargeLoading,   setChargeLoading]   = useState(false);
  const [overrideLoading, setOverrideLoading] = useState(false);
  const [error,           setError]           = useState<string | null>(null);

  const busy = chargeLoading || overrideLoading;

  async function handleCharge() {
    setError(null);
    setChargeLoading(true);
    const result = await chargeInstalment(paymentId);
    if (result.error) {
      setError(result.error);
      setChargeLoading(false);
    } else {
      window.location.reload();
    }
  }

  async function handleOverride() {
    setError(null);
    setOverrideLoading(true);
    const result = await markPaymentCollected(paymentId);
    if (result.error) {
      setError(result.error);
      setOverrideLoading(false);
    } else {
      window.location.reload();
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <button
          onClick={handleCharge}
          disabled={busy}
          className="px-2.5 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {chargeLoading ? 'Charging…' : 'Charge now'}
        </button>
        <button
          onClick={handleOverride}
          disabled={busy}
          className="px-2.5 py-1 text-xs font-medium rounded border border-gray-300 text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Mark as collected without charging the card (reconciliation override)"
        >
          {overrideLoading ? 'Saving…' : 'Manual override'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 max-w-55">{error}</p>}
    </div>
  );
}

// ─── Confirm / fail first payment (two buttons, shared error) ─────────────────

type FirstPaymentActionsProps = {
  planId: string;
  confirmFirstPayment: (planId: string) => Promise<{ error: string | null }>;
  failFirstPayment: (planId: string) => Promise<{ error: string | null }>;
};

export function FirstPaymentActions({
  planId,
  confirmFirstPayment,
  failFirstPayment,
}: FirstPaymentActionsProps) {
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [failLoading, setFailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = confirmLoading || failLoading;

  async function handleConfirm() {
    setError(null);
    setConfirmLoading(true);
    const result = await confirmFirstPayment(planId);
    if (result.error) {
      setError(result.error);
      setConfirmLoading(false);
    } else {
      window.location.reload();
    }
  }

  async function handleFail() {
    setError(null);
    setFailLoading(true);
    const result = await failFirstPayment(planId);
    if (result.error) {
      setError(result.error);
      setFailLoading(false);
    } else {
      window.location.reload();
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <button
          onClick={handleConfirm}
          disabled={busy}
          className="px-2.5 py-1 text-xs font-medium rounded bg-green-600 hover:bg-green-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {confirmLoading ? 'Confirming…' : 'Confirm payment'}
        </button>
        <button
          onClick={handleFail}
          disabled={busy}
          className="px-2.5 py-1 text-xs font-medium rounded bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {failLoading ? 'Failing…' : 'Payment failed'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 max-w-55">{error}</p>}
    </div>
  );
}
