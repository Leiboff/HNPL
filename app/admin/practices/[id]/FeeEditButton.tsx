'use client';

import { useState, useTransition } from 'react';

// Tiny in-place editor for practices.fee_percent. Hidden behind an
// "Edit" toggle so the page reads quietly when the operator isn't
// changing the rate. Calls the server action — no client-side
// optimistic UI, just transition pending state.
//
// Bounds (0–25%) are enforced server-side too; the input is a safety
// net not a security check.

type Result = { ok: true } | { ok: false; error: string };

type Props = {
  practiceId:  string;
  currentFee:  number;
  changeFee:   (practiceId: string, nextFee: number) => Promise<Result>;
};

export default function FeeEditButton({ practiceId, currentFee, changeFee }: Props) {
  const [open, setOpen]   = useState(false);
  const [value, setValue] = useState(String(currentFee));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const next = Number(value);
    if (!Number.isFinite(next)) { setError('Must be a number.'); return; }
    startTransition(async () => {
      const result = await changeFee(practiceId, next);
      if (result.ok) {
        setOpen(false);
      } else {
        setError(result.error);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setValue(String(currentFee)); setError(null); setOpen(true); }}
        className="text-xs font-medium text-[#15A89E] hover:text-[#13294B]"
      >
        Edit
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="inline-flex flex-col gap-1">
      <div className="inline-flex items-center gap-2">
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          step="0.01"
          min="0"
          max="25"
          autoFocus
          className="w-20 rounded border border-gray-300 px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]"
        />
        <span className="text-sm text-gray-500">%</span>
        <button
          type="submit"
          disabled={isPending}
          className="rounded bg-[#13294B] text-white px-2.5 py-1 text-xs font-medium disabled:opacity-60"
        >
          {isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null); }}
          className="text-xs text-gray-500 hover:text-gray-800"
        >
          Cancel
        </button>
      </div>
      <p className="text-[11px] text-gray-500 max-w-xs">
        Affects future payouts only — existing payout rows are locked in.
      </p>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </form>
  );
}
