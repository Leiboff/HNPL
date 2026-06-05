'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { resendConfirmation } from '@/app/auth/resend/actions';

function CheckCircleIcon() {
  return (
    <svg
      className="w-16 h-16"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden
      style={{ color: '#0F4C75' }}
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
      className="w-16 h-16 text-amber-400"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
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
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-gray-200 border-t-[#0F4C75] animate-spin" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-10 text-center">
          <div className="flex justify-center mb-6">
            <WarningIcon />
          </div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            Link expired or invalid
          </h1>
          <p className="text-sm text-gray-500 mb-6">
            This confirmation link has expired or has already been used.
            Please sign in, or sign up again to receive a new link.
          </p>

          {/* Resend section */}
          <div className="mb-6 text-left space-y-2">
            <p className="text-sm font-medium text-gray-700">
              Or enter your email to resend the confirmation link:
            </p>
            <input
              type="email"
              value={resendEmail}
              onChange={(e) => setResendEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {resendState === 'sent' && (
              <p className="text-sm font-medium text-green-700">
                If that email needs confirming, we&apos;ve sent a new link. Please check your inbox.
              </p>
            )}
            <button
              type="button"
              onClick={handleResend}
              disabled={resendState === 'sending' || resendState === 'sent' || !resendEmail.trim()}
              className="w-full rounded-xl px-6 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ backgroundColor: '#0F4C75' }}
            >
              {resendState === 'sending'
                ? 'Sending…'
                : resendState === 'sent'
                  ? 'Sent ✓'
                  : 'Resend confirmation email'}
            </button>
          </div>

          <div className="flex flex-col gap-3">
            <Link
              href="/login"
              className="inline-flex items-center justify-center w-full rounded-xl px-6 py-3 text-sm font-semibold text-gray-700 border border-gray-300 hover:bg-gray-50 transition-colors"
            >
              Go to sign in
            </Link>
            <Link
              href="/signup/patient"
              className="inline-flex items-center justify-center w-full rounded-xl border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Sign up again
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-10 text-center">
        <div className="flex justify-center mb-6">
          <CheckCircleIcon />
        </div>
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">
          Email confirmed
        </h1>
        <p className="text-sm text-gray-500 mb-8">
          Your BetterNow account is ready.
        </p>
        <Link
          href={destination}
          className="inline-flex items-center justify-center w-full rounded-xl px-6 py-3 text-sm font-semibold text-white transition-colors"
          style={{ backgroundColor: '#0F4C75' }}
        >
          Continue to dashboard
        </Link>
      </div>
    </div>
  );
}
