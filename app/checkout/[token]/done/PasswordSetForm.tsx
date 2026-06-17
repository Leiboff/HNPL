'use client';

import { useState, useTransition } from 'react';

// Password set is the ONLY way out of /checkout/[token]/done — no
// "Skip for now" affordance. Without OTP and without the patient ever
// seeing the temp passwords we used during the flow, skipping would
// leave them with no credential they know and only the "forgot
// password" channel for recovery. For a financial product where the
// plan is already live and money has already moved, that's not a
// trade-off worth offering.

type Props = {
  email:            string;
  finalizePassword: (password: string)
                      => Promise<{ ok: true } | { ok: false; error: string }>;
};

export default function PasswordSetForm({ email, finalizePassword }: Props) {
  const [password,        setPassword]        = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error,           setError]           = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8)           { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirmPassword)  { setError('Passwords don\'t match.'); return; }

    startTransition(async () => {
      const result = await finalizePassword(password);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Hard navigate to the patient portal — gives the proxy a clean
      // run with the fresh session.
      window.location.href = '/patient';
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-gray-600">
        You&apos;re signed in as <span className="font-mono">{email}</span>.
        Pick a password to use for future logins.
      </p>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
          New password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base"
        />
        <p className="mt-1 text-xs text-gray-400">At least 8 characters.</p>
      </div>

      <div>
        <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
          Confirm password
        </label>
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base"
        />
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg px-4 py-3 text-base font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 disabled:opacity-60 transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {isPending ? 'Saving…' : 'Set password & continue'}
      </button>

      <p className="text-center text-[11px] text-gray-400">
        You&apos;ll need this to log in later and manage your plan.
      </p>
    </form>
  );
}
