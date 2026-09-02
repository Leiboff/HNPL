'use client';

import { useState, useTransition } from 'react';
import { usePendingAction } from '@/components/loading/usePendingAction';
import { releaseFraudDecision } from './actions';

// The release control. A note is mandatory (the action enforces it too —
// this is the convenience, not the gate), and the button says what it does
// rather than "confirm", because the operator is overriding a refusal and
// should not be able to do it without reading the verb.

export default function ReleaseForm({ decisionId }: { decisionId: string }) {
  const [note,  setNote]  = useState('');
  const [error, setError] = useState<string | null>(null);
  // Server action + revalidatePath, so useTransition is the right mechanism
  // (see components/loading/usePendingAction.ts on why the two pending
  // shapes in this app are not interchangeable) — mirrored into the shared
  // hook for the same disabled/label timing as every other action.
  const [isPending, start] = useTransition();
  const pending = usePendingAction({ pending: isPending });

  return (
    <form
      className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await releaseFraudDecision(decisionId, note);
          if (res.error) setError(res.error);
          else setNote('');
        });
      }}
    >
      <div className="flex-1">
        <label htmlFor={`note-${decisionId}`} className="sr-only">
          Why is this customer being released?
        </label>
        <input
          id={`note-${decisionId}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why is this being released? e.g. called her — pays for 4 family members"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        {error && <p className="mt-1 text-xs font-medium text-red-700">{error}</p>}
      </div>
      <button
        type="submit"
        disabled={pending.disabled || note.trim().length < 8}
        className="rounded-lg bg-[#13294B] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
      >
        {pending.showLabel ? 'Releasing…' : 'Release this customer'}
      </button>
    </form>
  );
}
