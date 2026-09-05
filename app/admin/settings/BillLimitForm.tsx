'use client';

import { useActionState } from 'react';
import { updateMaxBillAmount, type BillLimitState } from './actions';

const INITIAL_STATE: BillLimitState = { error: null, success: null };

export default function BillLimitForm({ currentAmount }: { currentAmount: number }) {
  const [state, action, pending] = useActionState(updateMaxBillAmount, INITIAL_STATE);

  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="maxBillAmount" className="block text-sm font-medium text-gray-800">
          Maximum bill amount
        </label>
        <div className="mt-1 flex max-w-sm rounded-lg border border-gray-300 bg-white focus-within:ring-2 focus-within:ring-[#15A89E]">
          <span className="px-3 py-2 text-gray-500">R</span>
          <input
            id="maxBillAmount"
            name="maxBillAmount"
            type="number"
            min="0.01"
            max="30000"
            step="0.01"
            required
            defaultValue={currentAmount}
            className="min-w-0 flex-1 rounded-r-lg px-3 py-2 outline-none"
          />
        </div>
        <p className="mt-2 text-sm text-gray-500">
          Applies immediately to new dashboard, till, and direct API bills. The database ceiling is R30,000.
        </p>
      </div>
      {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
      {state.success && <p role="status" className="text-sm text-emerald-700">{state.success}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-[#13294B] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save bill limit'}
      </button>
    </form>
  );
}
