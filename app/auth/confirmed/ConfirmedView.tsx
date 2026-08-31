'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { resendConfirmation } from '@/app/auth/resend/actions';
import AuthSurface from '@/app/_components/AuthSurface';
import AuthWordmark from '@/app/_components/AuthWordmark';
import {
  AUTH_LABEL_CLS,
  AUTH_INPUT_CLS,
  AUTH_PRIMARY_CLS,
  AUTH_SECONDARY_CLS,
  AUTH_TITLE_CLS,
  AUTH_SUBTITLE_CLS,
  AUTH_SUCCESS_CLS,
  authPrimaryStyle,
} from '@/app/_components/authFormStyles';

// ─── Email-confirmed landing (client) ──────────────────────────────────
//
// Two outcomes, one screen: the link worked, or it didn't. Both now sit
// on the shared auth surface — this is the screen a patient lands on
// straight from their inbox, mid-signup, and it used to be the one grey
// gov-form-looking page in an otherwise navy journey.
//
// The old icons were drawn in #0F4C75, a blue that appears nowhere in the
// brand palette (app/landing.css) and had drifted in from an earlier
// design. Success is the brand accent; the failure state is the same
// amber the rest of the journey warns in.

function MailCheckIcon() {
  return (
    <svg
      className="h-8 w-8"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.6}
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
      />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      className="h-8 w-8"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.6}
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
      />
    </svg>
  );
}

/** The round badge above the headline. Accent for success, amber for failure. */
function StatusBadge({ tone, children }: { tone: 'accent' | 'amber'; children: React.ReactNode }) {
  const cls = tone === 'accent'
    ? 'border-[var(--auth-accent-edge)] bg-[var(--auth-accent-tint)] text-[var(--auth-accent)]'
    : 'border-amber-300/30 bg-amber-400/[.10] text-amber-200';
  return (
    <div className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border ${cls}`}>
      {children}
    </div>
  );
}

type State = 'loading' | 'success' | 'error';

export default function ConfirmedView({ destination }: { destination: string }) {
  const [state, setState] = useState<State>('loading');

  // Resend state — only used in the error branch
  const [resendEmail, setResendEmail] = useState('');
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    setState(params.get('error') ? 'error' : 'success');
  }, []);

  async function handleResend() {
    if (!resendEmail.trim()) return;
    setResendState('sending');
    try {
      await resendConfirmation(resendEmail.trim());
    } catch {
      // Transport-level failure — still show neutral message.
    }
    setResendState('sent');
    setTimeout(() => setResendState('idle'), 30_000);
  }

  if (state === 'loading') {
    return (
      <AuthSurface centred>
        <div className="flex justify-center">
          <div
            className="h-8 w-8 animate-spin rounded-full border-[3px] border-[var(--auth-edge)] border-t-[var(--auth-accent)]"
            aria-hidden
          />
        </div>
      </AuthSurface>
    );
  }

  if (state === 'error') {
    return (
      <AuthSurface centred>
        <AuthWordmark size="md" />

        <div className="mt-9">
          <StatusBadge tone="amber"><WarningIcon /></StatusBadge>
          <h1 className={`text-center ${AUTH_TITLE_CLS}`}>
            Link expired or invalid
          </h1>
          <p className={`mt-3 text-center ${AUTH_SUBTITLE_CLS}`}>
            This confirmation link has expired or has already been used.
            Please sign in, or sign up again to receive a new link.
          </p>
        </div>

        <div className="mt-8 space-y-3">
          <div>
            <label htmlFor="confirmed-resend-email" className={AUTH_LABEL_CLS}>
              Or enter your email to resend the confirmation link
            </label>
            <input
              id="confirmed-resend-email"
              type="email"
              value={resendEmail}
              onChange={(e) => setResendEmail(e.target.value)}
              placeholder="you@example.com"
              className={AUTH_INPUT_CLS}
            />
          </div>

          {resendState === 'sent' && (
            <p className={AUTH_SUCCESS_CLS}>
              If that email needs confirming, we&apos;ve sent a new link. Please check your inbox.
            </p>
          )}

          <button
            type="button"
            onClick={handleResend}
            disabled={resendState === 'sending' || resendState === 'sent' || !resendEmail.trim()}
            className={AUTH_PRIMARY_CLS}
            style={authPrimaryStyle(resendState !== 'idle' || !resendEmail.trim())}
          >
            {resendState === 'sending'
              ? 'Sending…'
              : resendState === 'sent'
                ? 'Sent ✓'
                : 'Resend confirmation email'}
          </button>
        </div>

        <div className="mt-8 flex flex-col gap-3 border-t border-[var(--auth-hairline)] pt-7">
          <Link href="/login" className={AUTH_SECONDARY_CLS}>
            Go to sign in
          </Link>
          <Link href="/signup" className={AUTH_SECONDARY_CLS}>
            Sign up again
          </Link>
        </div>
      </AuthSurface>
    );
  }

  return (
    <AuthSurface centred>
      <AuthWordmark size="md" />

      <div className="mt-9">
        <StatusBadge tone="accent"><MailCheckIcon /></StatusBadge>
        <h1 className={`text-center ${AUTH_TITLE_CLS}`}>
          Email confirmed
        </h1>
        <p className={`mt-3 text-center ${AUTH_SUBTITLE_CLS}`}>
          Your BetterNow account is ready.
        </p>
      </div>

      <div className="mt-9">
        <Link href={destination} className={AUTH_PRIMARY_CLS} style={authPrimaryStyle()}>
          Continue to dashboard
        </Link>
      </div>
    </AuthSurface>
  );
}
