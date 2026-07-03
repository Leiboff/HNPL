'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { isValidEmail } from '@/lib/validation';

// ─── Forgot-password request form (enumeration-safe) ───────────────────
//
// Contract:
//   • On submit, ALWAYS show the same success state, whether or not
//     the email matches an account. Never reveal existence.
//   • Rate-limit errors from Supabase (429 / "email rate limit
//     exceeded") get a friendly "try again in a minute" — never a
//     raw error.
//   • Client-side email format check only blocks obviously-bad input
//     (missing @, etc.). It does NOT reveal existence.
//
// Recovery link redirect target: `/auth/callback?next=/update-password`.
// The callback route exchanges the PKCE code, sets cookies, and lands
// the user on /update-password with a live recovery session. See
// app/auth/callback/route.ts.

const REDIRECT_NEXT = '/update-password';

export default function ForgotPasswordForm() {
  const [email,     setEmail]     = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  // Query-param error handling — the /auth/callback route redirects
  // here with `?error=expired` when a recovery link is stale or
  // malformed. Derive the banner state DIRECTLY from the URL param
  // (no useState + useEffect — that would trip the
  // react-hooks/set-state-in-effect lint rule for no benefit). We
  // hide the banner locally by mounting a fresh submission attempt.
  const params        = useSearchParams();
  const errorParam    = params?.get('error') ?? null;
  const [dismissedExpired, setDismissedExpired] = useState(false);
  const linkExpired   = errorParam === 'expired' && !dismissedExpired;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isValidEmail(email)) {
      // Format-only guard. Not enumeration.
      setError('Enter a valid email address.');
      return;
    }
    setLoading(true);
    const supabase = createClient();
    // The redirectTo URL must match one of the entries in the
    // Supabase project's Auth → URL Configuration allowlist.
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const { error: supErr } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(REDIRECT_NEXT)}`,
    });
    setLoading(false);

    // ENUMERATION-SAFE: we show the same success state whether the
    // email exists or not. A rate-limit error (429 / "email rate
    // limit exceeded") is the ONE case we distinguish, because
    // silently pretending success would leave a user stranded when
    // they legitimately just requested another reset.
    if (supErr) {
      const msg = supErr.message.toLowerCase();
      const looksRateLimited =
        supErr.status === 429
        || msg.includes('rate limit')
        || msg.includes('too many requests')
        || msg.includes('security purposes');
      if (looksRateLimited) {
        setError('Please wait a minute before requesting another reset link.');
        return;
      }
      // Any other error is unusual — treat as success to preserve
      // enumeration-safety (a leaked "user not found"-style error
      // would defeat the whole point). Log server-side via console
      // for debugging; do not surface to the user.
      console.warn('[forgot-password] non-rate-limit supabase error', supErr.message);
    }

    setSubmitted(true);
  }

  // Success state — deliberately identical whether the email
  // matched or not.
  if (submitted) {
    return (
      <Card>
        <div className="w-14 h-14 mx-auto rounded-full flex items-center justify-center bg-emerald-50 text-emerald-700 mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <path d="M4 6l8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="4" y="5" width="16" height="14" rx="2" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-center" style={{ color: '#13294B' }}>
          Check your inbox
        </h1>
        <p className="mt-2 text-sm text-gray-600 text-center leading-relaxed">
          If an account exists for that email, we&apos;ve sent a reset link.
          Open it on this device to set a new password. The link expires
          in an hour.
        </p>
        <p className="mt-4 text-xs text-gray-400 text-center">
          Can&apos;t see it? Check your spam folder. Still nothing?{' '}
          <button
            type="button"
            onClick={() => { setSubmitted(false); setDismissedExpired(true); }}
            className="underline underline-offset-2 hover:text-gray-600"
          >
            Try a different email
          </button>
          .
        </p>
        <div className="mt-6 text-center">
          <Link href="/login" className="text-sm font-semibold underline underline-offset-2" style={{ color: '#13294B' }}>
            Back to sign in
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <Brand />
      <h1 className="mt-6 text-2xl font-semibold text-center" style={{ color: '#13294B' }}>
        Reset your password
      </h1>
      <p className="mt-1 text-sm text-gray-500 text-center">
        Enter the email you signed up with. We&apos;ll send you a link to set a new password.
      </p>

      {linkExpired && (
        <div className="mt-5 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900" role="alert" data-testid="forgot-password-link-expired">
          Your previous reset link has expired or already been used. Request a new one below.
        </div>
      )}

      {error && (
        <div className="mt-5 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="fp-email" className="block text-sm font-medium text-gray-700 mb-1">
            Email
          </label>
          <input
            id="fp-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="forgot-password-email"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none transition-all focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20"
            placeholder="you@example.com"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          data-testid="forgot-password-submit"
          className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {loading ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      <div className="mt-6 text-center">
        <Link href="/login" className="text-sm font-semibold underline underline-offset-2" style={{ color: '#13294B' }}>
          Back to sign in
        </Link>
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200/80 p-8">
      {children}
    </div>
  );
}

function Brand() {
  return (
    <div className="text-center">
      <Link href="/" className="inline-block text-2xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
        <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
      </Link>
    </div>
  );
}
