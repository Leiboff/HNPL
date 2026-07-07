'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { resendConfirmation } from '@/app/auth/resend/actions';

// ─── Verify email step (client) ────────────────────────────────────────
//
// 6-digit OTP entry. Reuses the existing supabase.auth.verifyOtp({email,
// token, type: 'email'}) mechanism the standalone /verify-email page
// already uses — same server-side path, just wrapped in the onboarding
// shell + routing back to /onboarding on success (which then forwards
// to the next unfinished step).

const CELL_CLS =
  'w-11 h-14 sm:w-12 sm:h-16 rounded-lg border border-gray-300 text-center text-xl font-semibold ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-2 focus:ring-[#15A89E]/20';

export default function VerifyEmailStepClient({ email }: { email: string }) {
  const [code, setCode]       = useState('');
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code we sent to your email.');
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error: err } = await supabase.auth.verifyOtp({
      email,
      token: code.trim(),
      type:  'email',
    });
    setLoading(false);

    if (err) {
      const msg = err.message.toLowerCase();
      if (msg.includes('expired')) {
        setError('That code has expired. Resend a new one below.');
      } else if (msg.includes('invalid')) {
        setError('That code doesn\'t match. Check it and try again.');
      } else {
        setError(err.message);
      }
      return;
    }

    // Success — recompute state and forward to the next step.
    window.location.href = '/onboarding';
  }

  async function handleResend() {
    setResendState('sending');
    try { await resendConfirmation(email); } catch { /* neutral message either way */ }
    setResendState('sent');
    setTimeout(() => setResendState('idle'), 30_000);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="otp" className="block text-sm font-medium text-gray-700 mb-2">
          6-digit code
        </label>
        <input
          id="otp"
          type="text"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          data-testid="onboarding-email-otp"
          className={CELL_CLS + ' w-full h-14 sm:h-16 tracking-[0.5em] px-3'}
          placeholder="••••••"
        />
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        data-testid="onboarding-email-verify"
        className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {loading ? 'Verifying…' : 'Continue'}
      </button>

      <div className="text-center">
        <button
          type="button"
          onClick={handleResend}
          disabled={resendState !== 'idle'}
          className="text-xs text-gray-500 hover:underline disabled:opacity-50"
        >
          {resendState === 'sending' ? 'Sending…' : resendState === 'sent' ? 'Sent — check your inbox' : 'Resend the code'}
        </button>
      </div>
    </form>
  );
}
