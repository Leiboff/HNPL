'use client';

import { useState } from 'react';
import { usePasskeys, passkeyErrorMessage } from '@/lib/hooks/usePasskeys';
import { skipPasskeyPrompt, dontAskAgainPasskey } from './passkey-actions';

// ─── Post-login passkey prompt — full-sheet overlay ────────────────────
//
// Rendered by the patient layout when the layout's server-side check
// says the frequency cap allows it (login_count >= next_show_at_login
// AND !permanent_dismiss). The client component adds one more gate:
// self-hide when the user already has a passkey enrolled (checked via
// Supabase auth.passkey.list on mount — the layout can't check this
// server-side without an admin API call).
//
// Actions:
//   • "Set up passkey" — reuses the existing usePasskeys().register
//     (WebAuthn ceremony). On success or user-cancel, hide.
//   • "Skip for now"   — skipPasskeyPrompt server action → bumps
//     next_show_at_login by 3.
//   • "Don't ask again" — dontAskAgainPasskey → permanent_dismiss.
//
// Not blocking. Skip must be instant — one click, one server call,
// no confirmation dialog.

type Props = {
  /** Server-computed decision. False → this component renders null
      immediately (the frequency cap suppresses this login). */
  serverAllows: boolean;
};

export default function PostLoginPasskeyPrompt({ serverAllows }: Props) {
  const [visible, setVisible] = useState(true);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const { passkeys, loading, supported, register } = usePasskeys();

  // Layered gates — cheapest checks first.
  if (!serverAllows) return null;
  if (!visible)      return null;
  if (!supported)    return null;         // no WebAuthn → nothing to offer
  if (loading)       return null;         // don't paint before we know
  if (passkeys.length > 0) return null;   // already enrolled — never show

  async function handleRegister() {
    setBusy(true);
    setError(null);
    const { ok, error: code } = await register();
    setBusy(false);
    if (ok) {
      setVisible(false);
      return;
    }
    if (code === 'user_cancelled') {
      // Cancelled WebAuthn ceremony counts as a skip.
      await skipPasskeyPrompt();
      setVisible(false);
      return;
    }
    setError(code ? passkeyErrorMessage(code) : 'Something went wrong. Please try again.');
  }

  async function handleSkip() {
    setBusy(true);
    await skipPasskeyPrompt();
    setBusy(false);
    setVisible(false);
  }

  async function handleDontAskAgain() {
    setBusy(true);
    await dontAskAgainPasskey();
    setBusy(false);
    setVisible(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Set up a passkey"
      data-testid="post-login-passkey-prompt"
    >
      <div className="w-full max-w-md bg-white rounded-3xl shadow-lg p-6 sm:p-8 space-y-5">
        {/* Icon */}
        <div
          aria-hidden
          className="w-14 h-14 rounded-2xl flex items-center justify-center text-white"
          style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <rect x="4" y="10" width="16" height="10" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" strokeLinecap="round" />
            <circle cx="12" cy="15" r="1.5" />
          </svg>
        </div>

        <div>
          <h2 className="text-xl font-semibold" style={{ color: 'var(--portal-ink)' }}>
            Sign in faster next time
          </h2>
          <p className="mt-2 text-sm text-gray-600 leading-relaxed">
            Save a passkey and sign in with Face ID, your fingerprint, or your
            device PIN — no password needed. Your passkey never leaves this device.
          </p>
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="space-y-2">
          <button
            type="button"
            onClick={handleRegister}
            disabled={busy}
            data-testid="post-login-passkey-setup"
            className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
          >
            {busy ? 'Setting up…' : 'Set up passkey'}
          </button>
          <button
            type="button"
            onClick={handleSkip}
            disabled={busy}
            data-testid="post-login-passkey-skip"
            className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            Skip for now
          </button>
        </div>

        <div className="text-center">
          <button
            type="button"
            onClick={handleDontAskAgain}
            disabled={busy}
            data-testid="post-login-passkey-never"
            className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2 disabled:opacity-60"
          >
            Don&apos;t ask again
          </button>
        </div>
      </div>
    </div>
  );
}
