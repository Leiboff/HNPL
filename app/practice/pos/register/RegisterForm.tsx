'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { RedeemCodeResult } from '../actions';
import { TILL_DEVICE_SECRET_KEY } from '../tillStorage';

type Props = {
  redeemDeviceRegistrationCode: (code: string, label: string, userAgent: string) => Promise<RedeemCodeResult>;
};

const MAX_NAME_LEN = 60;

export default function RegisterForm({ redeemDeviceRegistrationCode }: Props) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const trimmedName = name.trim();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Capture the device's own user-agent so the manager can see the
    // model (e.g. "Samsung SM-S911B") in the device list. Guarded for SSR /
    // non-browser test envs.
    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    startTransition(async () => {
      const result = await redeemDeviceRegistrationCode(code, trimmedName, userAgent);
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
        <label htmlFor="reg-name" className="block text-sm font-medium text-gray-700 mb-1.5">
          Device name
        </label>
        <input
          id="reg-name"
          type="text"
          maxLength={MAX_NAME_LEN}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Front desk PC"
          data-testid="registration-name-input"
          className="w-full rounded-lg border border-gray-300 px-3.5 py-3 text-base text-gray-900"
        />
        <p className="mt-1.5 text-xs text-gray-500">
          A name so your manager can tell this till apart from others.
        </p>
      </div>

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
        disabled={isPending || code.length !== 8 || trimmedName.length === 0}
        className="w-full inline-flex items-center justify-center rounded-lg bg-[var(--portal-ink)] [background:linear-gradient(135deg,var(--portal-ink)_0%,var(--portal-accent)_145%)] px-6 py-3 text-sm font-semibold text-white hover:shadow-lg transition-shadow disabled:opacity-60"
      >
        {isPending ? 'Registering…' : 'Register this till'}
      </button>
    </form>
  );
}
