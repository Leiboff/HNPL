'use client';

import Link from 'next/link';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { checkPassword } from '@/lib/validation';
import { usePendingAction } from '@/components/loading/usePendingAction';
import AuthWordmark from '@/app/_components/AuthWordmark';
import {
  AUTH_LABEL_CLS,
  AUTH_INPUT_CLS,
  AUTH_PRIMARY_CLS,
  AUTH_ERROR_CLS,
  AUTH_TITLE_CLS,
  AUTH_SUBTITLE_CLS,
  authPrimaryStyle,
} from '@/app/_components/authFormStyles';

// ─── Set a new password (post-recovery-link form) ─────────────────────
//
// Rendered inside <AuthSurface> by the page: same ground, same controls
// and same wordmark as /login, which is where this flow started and where
// it hands back if the link has gone stale.
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
  // Mirrors the flag above for PRESENTATION only — the flag and the call
  // it guards are untouched. pending.disabled follows it immediately
  // (double-tap safety is never delayed); pending.showLabel waits out the
  // flash threshold. See components/loading/usePendingAction.ts.
  const pending = usePendingAction({ pending: loading });
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

    // The password changed, so every OTHER session must die. This is the
    // whole point of a password reset: the usual reason to do one is that
    // somebody else may hold a session, and Supabase's `local` logout
    // never touched other devices' refresh tokens — so before this, a
    // reset changed the credential and left the intruder signed in.
    //
    // scope:'others' rather than 'global' deliberately: it keeps THIS
    // browser signed in, which is both what the user expects (they are
    // about to be sent to /dashboard) and safe, because they just proved
    // control of the account here.
    //
    // Awaited, not fired-and-forgotten: we are not racing a navigation
    // here the way logout does, and a revocation that silently didn't
    // happen is worse than a redirect that takes another moment.
    try {
      await supabase.auth.signOut({ scope: 'others' });
    } catch (revokeErr) {
      // Not surfaced to the user — their password DID change, and telling
      // them otherwise would be wrong. Logged so a systematic failure is
      // visible.
      console.error('[update-password] failed to revoke other sessions', revokeErr);
    }

    // Success — send them to the canonical role-dispatcher. This is
    // the SAME redirect the login page uses; from here /dashboard
    // reads profiles.role and forwards to /patient, /practice,
    // /provider, or /admin.
    window.location.href = '/dashboard';
  }

  if (showRecoveryError) {
    return (
      <>
        <div
          className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-amber-300/30 bg-amber-400/[.10] text-amber-200"
          aria-hidden
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <circle cx="12" cy="12" r="9" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5v5M12 16.25h.008" />
          </svg>
        </div>
        <h1 className={`text-center ${AUTH_TITLE_CLS}`}>
          This link isn&apos;t valid any more
        </h1>
        <p className={`mt-3 text-center ${AUTH_SUBTITLE_CLS}`}>
          The reset link has expired or already been used. Request a fresh one
          and we&apos;ll email you a new link.
        </p>
        <div className="mt-8">
          <Link
            href="/forgot-password"
            data-testid="update-password-request-new-link"
            className={AUTH_PRIMARY_CLS}
            style={authPrimaryStyle()}
          >
            Request a new link
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <AuthWordmark size="md" />
      <h1 className={`mt-9 text-center ${AUTH_TITLE_CLS}`}>
        Set a new password
      </h1>
      <p className={`mt-3 text-center ${AUTH_SUBTITLE_CLS}`}>
        You&apos;re resetting the password for{' '}
        <span className="font-semibold text-white">{email}</span>.
      </p>

      {error && (
        <div className={`mt-6 ${AUTH_ERROR_CLS}`} role="alert">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-8 space-y-4" noValidate>
        <div>
          <label htmlFor="up-password" className={AUTH_LABEL_CLS}>
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
            className={AUTH_INPUT_CLS}
            placeholder="At least 8 characters"
          />
        </div>

        <div>
          <label htmlFor="up-confirm" className={AUTH_LABEL_CLS}>
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
            className={AUTH_INPUT_CLS}
            placeholder="Repeat password"
          />
        </div>

        <button
          type="submit"
          disabled={pending.disabled}
          data-testid="update-password-submit"
          className={AUTH_PRIMARY_CLS}
          style={authPrimaryStyle(pending.disabled)}
        >
          {pending.showLabel ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </>
  );
}
