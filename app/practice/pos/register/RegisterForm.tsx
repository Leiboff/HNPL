'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { RedeemCodeResult } from '../actions';
import { TILL_DEVICE_SECRET_KEY } from '../tillStorage';

type Props = {
  redeemDeviceRegistrationCode: (code: string) => Promise<RedeemCodeResult>;
};

export default function RegisterForm({ redeemDeviceRegistrationCode }: Props) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await redeemDeviceRegistrationCode(code);
      if (result.error || !result.deviceSecret) {
        setError(result.error ?? 'Could not register this till. Please try again.');
        return;
      }
      // Persistent, not a cookie — the device credential outlives any
      // single browser session and is not tied to a Supabase user JWT.
      window.localStorage.setItem(TILL_DEVICE_SECRET_KEY, result.deviceSecret);
      router.replace('/practice/pos');
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 rounded-2xl border border-gray-200 bg-white p-6">
      <div>
        <label htmlFor="reg-code" className="block text-sm font-medium text-gray-700 mb-1.5">
          Registration code
        </label>
        <input
          id="reg-code"
          type="text"
          inputMode="numeric"
          maxLength={8}
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="8-digit code"
          data-testid="registration-code-input"
          className="w-full rounded-lg border border-gray-300 px-3.5 py-3 text-lg font-mono tracking-widest text-center text-gray-900"
        />
        <p className="mt-1.5 text-xs text-gray-500">
          Ask your practice manager for a one-time code.
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending || code.length !== 8}
        className="w-full inline-flex items-center justify-center rounded-lg bg-[#13294B] [background:linear-gradient(135deg,#13294B_0%,#15A89E_145%)] px-6 py-3 text-sm font-semibold text-white hover:shadow-lg transition-shadow disabled:opacity-60"
      >
        {isPending ? 'Registering…' : 'Register this till'}
      </button>
    </form>
  );
}
