'use client';

import Link from 'next/link';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { checkPassword } from '@/lib/validation';

// ─── Set a new password (post-recovery-link form) ─────────────────────
//
// Reuses the shared checkPassword() validator + the same "≥8 chars"
// floor the signup surfaces enforce. Same rules, same errors — this
// form is NOT a place to fork the password policy.
//
// Contract:
//   • New + Confirm inputs. Inline errors on weak/mismatch.
//   • On success → supabase.auth.updateUser({ password }) → redirect
//     to /dashboard, which routes to the correct area for the user's
//     role. (Reuses the canonical post-login redirect logic.)
//   • On expired/invalid recovery-session error → bounce back to
//     /forgot-password?error=expired.

const MIN_PASSWORD_LEN = 8;

type Props = {
  /** Email is display-only here — we can't/don't want to let the
      caller change it via this form. Included so the form can hint
      "You're resetting the password for <email>" for clarity. */
  email: string;
};

export default function UpdatePasswordForm({ email }: Props) {
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [showRecoveryError, setShowRecoveryError] = useState(false);

  function validate(): string | null {
    if (password.length < MIN_PASSWORD_LEN) {
      return `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
    }
    const guard = checkPassword(password, email);
    if (!guard.ok) {
      return guard.reason === 'contains_email_local_part'
        ? "Please choose a password that doesn't contain your email address."
        : 'That password is too common. Please choose a less guessable one.';
    }
    if (password !== confirm) {
      return "Passwords don't match.";
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setLoading(true);
    const supabase = createClient();
    const { error: supErr } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (supErr) {
      const msg = supErr.message.toLowerCase();
      // The most common failure mode here is a stale/consumed
      // recovery token (user opened the link twice, or the ~1h TTL
      // elapsed). Send them back to request a new one.
      const looksLikeRecoveryStale =
        supErr.status === 401
        || msg.includes('jwt')
        || msg.includes('expired')
        || msg.includes('not authenticated')
        || msg.includes('invalid');
      if (looksLikeRecoveryStale) {
        setShowRecoveryError(true);
        return;
      }
      setError(supErr.message);
      return;
    }

    // Success — send them to the canonical role-dispatcher. This is
    // the SAME redirect the login page uses; from here /dashboard
    // reads profiles.role and forwards to /patient, /practice,
    // /provider, or /admin.
    window.location.href = '/dashboard';
  }

  if (showRecoveryError) {
    return (
      <Card>
        <div className="w-14 h-14 mx-auto rounded-full flex items-center justify-center bg-amber-50 text-amber-800 mb-4">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <circle cx="12" cy="12" r="9" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5v5M12 16.25h.008" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-center" style={{ color: '#13294B' }}>
          This link isn&apos;t valid any more
        </h1>
        <p className="mt-2 text-sm text-gray-600 text-center leading-relaxed">
          The reset link has expired or already been used. Request a fresh one
          and we&apos;ll email you a new link.
        </p>
        <div className="mt-6">
          <Link
            href="/forgot-password"
            data-testid="update-password-request-new-link"
            className="block w-full text-center rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            Request a new link
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <Brand />
      <h1 className="mt-6 text-2xl font-semibold text-center" style={{ color: '#13294B' }}>
        Set a new password
      </h1>
      <p className="mt-1 text-sm text-gray-500 text-center">
        You&apos;re resetting the password for{' '}
        <span className="font-medium text-gray-700">{email}</span>.
      </p>

      {error && (
        <div className="mt-5 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
        <div>
          <label htmlFor="up-password" className="block text-sm font-medium text-gray-700 mb-1">
            New password
          </label>
          <input
            id="up-password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LEN}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="update-password-new"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none transition-all focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20"
            placeholder="At least 8 characters"
          />
        </div>

        <div>
          <label htmlFor="up-confirm" className="block text-sm font-medium text-gray-700 mb-1">
            Confirm password
          </label>
          <input
            id="up-confirm"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LEN}
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            data-testid="update-password-confirm"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none transition-all focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20"
            placeholder="Repeat password"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          data-testid="update-password-submit"
          className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {loading ? 'Updating…' : 'Update password'}
        </button>
      </form>
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
