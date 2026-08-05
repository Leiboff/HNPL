'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { resendConfirmation } from '@/app/auth/resend/actions';
import OtpInput, { OTP_LENGTH } from '@/components/OtpInput';

// ─── VerifyEmailForm ─────────────────────────────────────────────────────────
//
// Client side of /verify-email. Three things happen here and nowhere else:
//
//   1. Calls supabase.auth.verifyOtp({ email, token, type: 'email' }) with
//      the user's 6-digit code. On success the SSR cookies are set by the
//      browser client and we hard-navigate to `next` so Next.js re-renders
//      with a live session.
//
//   2. Resend button. Triggers the existing resendConfirmation server
//      action (which re-sends Supabase's signup OTP via the configured
//      email template). 45-second cooldown with visible countdown.
//
//   3. Error states. Wrong code, expired code, and the Supabase rate-limit
//      response each map to a distinct user-facing message with the resend
//      path as the recovery action.

type Props = {
  email: string;
  next:  string;
};

type Phase = 'idle' | 'verifying' | 'error' | 'success';

const COOLDOWN_SECONDS = 45;

// Classify Supabase's verifyOtp error.
//
// IMPORTANT — message-based heuristics are unsafe here. GoTrue returns
// the message "Token has expired or is invalid" for BOTH:
//   • A genuinely expired OTP (past the 600s window)
//   • A wrong-but-current code the user typo'd
// We previously substring-matched 'expired' in the message, which
// classified every wrong code as expired. The structured error.code
// field is the authoritative signal:
//   • 'otp_expired'  — truly expired
//   • 'over_*_rate_limit', 'over_request_rate_limit', etc. — rate limit
//   • anything else (including the misleading message) — wrong code
type SupabaseAuthError = {
  code?:    string;
  message?: string;
  status?:  number;
};

function classifyVerifyError(error: SupabaseAuthError): 'expired' | 'rate_limited' | 'wrong_code' {
  const code = (error.code ?? '').toLowerCase();

  // Authoritative signal of true expiry.
  if (code === 'otp_expired') return 'expired';

  // Supabase rate-limit codes all carry 'rate_limit' in the slug.
  if (code.includes('rate_limit') || code === 'too_many_requests') return 'rate_limited';

  // Fallback to HTTP status / message ONLY when no code field was set
  // (older Supabase auth versions, transport-level failures).
  if (!code) {
    if (error.status === 429) return 'rate_limited';
    const m = (error.message ?? '').toLowerCase();
    if (m.includes('too many requests') || m.includes('rate limit')) return 'rate_limited';
    // We deliberately do NOT match 'expired' in the message here — see
    // the comment block above. The default for any verifyOtp failure
    // without a structured code is "wrong code".
  }

  return 'wrong_code';
}

const ERROR_TEXT: Record<'expired' | 'rate_limited' | 'wrong_code', string> = {
  expired:      'That code has expired. Tap "Resend code" to get a new one.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
  wrong_code:   'That code is incorrect. Please check and try again.',
};

export default function VerifyEmailForm({ email, next }: Props) {
  const [code,         setCode]      = useState('');
  const [phase,        setPhase]     = useState<Phase>('idle');
  const [errorKey,     setErrorKey]  = useState<'expired' | 'rate_limited' | 'wrong_code' | null>(null);
  const [resendState,  setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [cooldown,     setCooldown]  = useState(0);

  // Countdown ticker for the resend cooldown.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setInterval(() => setCooldown((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, [cooldown]);

  async function verify(submittedCode: string) {
    if (submittedCode.length !== OTP_LENGTH || !/^\d{6}$/.test(submittedCode)) {
      setPhase('error');
      setErrorKey('wrong_code');
      return;
    }
    setPhase('verifying');
    setErrorKey(null);

    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: submittedCode,
      type:  'email',
    });

    if (error) {
      setPhase('error');
      // Pass the full error object — classifyVerifyError reads error.code
      // (authoritative) first, then falls back to status / message only
      // when no structured code is set. See the comment on the function.
      setErrorKey(classifyVerifyError(error as SupabaseAuthError));
      return;
    }

    setPhase('success');
    // Hard navigation so SSR picks up the freshly-set auth cookies.
    window.location.href = next;
  }

  async function handleResend() {
    if (cooldown > 0 || resendState === 'sending') return;
    setResendState('sending');
    try {
      await resendConfirmation(email);
    } catch {
      // resendConfirmation already swallows internals; nothing to surface.
    }
    setResendState('sent');
    setCooldown(COOLDOWN_SECONDS);
    // Reset the "Sent ✓" indicator after the cooldown ends.
    window.setTimeout(() => setResendState('idle'), COOLDOWN_SECONDS * 1000);
    // Clear any "expired"-type error since the user has just kicked off a new code.
    if (errorKey === 'expired') {
      setErrorKey(null);
      setPhase('idle');
    }
  }

  function handleChange(next: string) {
    setCode(next);
    // Once the user has typed past the first cell, clear any error so the
    // input doesn't stay red while they're correcting their entry.
    if (phase === 'error') setPhase('idle');
  }

  const disabled    = phase === 'verifying' || phase === 'success';
  const ctaDisabled = disabled || code.length !== OTP_LENGTH;

  return (
    <div className="flex flex-1 flex-col">
      <OtpInput
        value={code}
        onChange={handleChange}
        onComplete={(full) => verify(full)}
        disabled={disabled}
        hasError={phase === 'error'}
        autoFocus
      />

      {phase === 'error' && errorKey && (
        <div
          role="alert"
          data-testid="otp-error"
          className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {ERROR_TEXT[errorKey]}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-[18px] pt-8">
        <button
          type="button"
          onClick={() => verify(code)}
          disabled={ctaDisabled}
          className="flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all disabled:opacity-45 disabled:cursor-not-allowed"
          style={{
            background: '#15A89E',
            boxShadow:  ctaDisabled ? 'none' : '0 10px 22px -12px rgba(21,168,158,0.9)',
          }}
        >
          {phase === 'verifying' ? 'Verifying…' : phase === 'success' ? 'Verified ✓' : 'Verify email'}
        </button>

        <div className="text-center text-[14px]" style={{ color: '#6B7C93' }}>
          Didn&apos;t get the code?{' '}
          <button
            type="button"
            onClick={handleResend}
            disabled={cooldown > 0 || resendState === 'sending' || phase === 'success'}
            data-testid="otp-resend"
            className="font-semibold hover:underline disabled:no-underline disabled:cursor-not-allowed"
            style={{ color: cooldown > 0 ? '#94a3b8' : '#13294B' }}
          >
            {resendState === 'sending'
              ? 'Sending…'
              : cooldown > 0
                ? `Resend in ${cooldown}s`
                : resendState === 'sent'
                  ? 'Code sent ✓'
                  : 'Resend code'}
          </button>
        </div>
      </div>
    </div>
  );
}
