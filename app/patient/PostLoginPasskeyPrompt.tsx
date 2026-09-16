'use client';

import { useState } from 'react';
import { usePasskeys, passkeyErrorMessage } from '@/lib/hooks/usePasskeys';
import BottomSheet, { SheetRow } from './BottomSheet';
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
    <BottomSheet
      open
      onClose={handleSkip}
      label="Set up a passkey"
      title="Sign in faster next time"
      blurb="Save a passkey and sign in with Face ID, your fingerprint, or your device PIN — no password to type or remember."
      testid="post-login-passkey-prompt"
      footer={
        <div className="flex flex-col gap-[10px]">
          {error && (
            <p role="alert" className="rounded-tile px-4 py-3 text-[13px]" style={{ background: 'rgba(180,35,24,.10)', border: '1px solid rgba(180,35,24,.25)', color: '#B42318' }}>
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={handleRegister}
            disabled={busy}
            data-testid="post-login-passkey-setup"
            className="bn-btn-navy w-full rounded-tile py-4 text-[15px] font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? 'Setting up…' : 'Set up passkey'}
          </button>
          {/* Two ways out, and they are NOT the same: Skip means "not
              today" and lets the frequency cap bring this back, "Don't ask
              again" is permanent. Keeping them visually different sizes is
              what stops a patient spending the permanent one by accident
              on the one they meant. */}
          <button
            type="button"
            onClick={handleSkip}
            disabled={busy}
            data-testid="post-login-passkey-skip"
            className="bn-btn-wash w-full rounded-tile py-4 text-[15px] font-semibold disabled:opacity-60"
            style={{ color: 'var(--portal-ink-2)' }}
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={handleDontAskAgain}
            disabled={busy}
            data-testid="post-login-passkey-never"
            className="w-full py-1 text-center text-[12px] underline underline-offset-2 disabled:opacity-60"
            style={{ color: 'var(--portal-faint)' }}
          >
            Don&apos;t ask again
          </button>
        </div>
      }
    >
      <SheetRow
        tone="teal"
        icon={<FaceGlyph />}
        title="Nothing to remember"
        body="Your face or fingerprint replaces the password, so there is nothing to forget or reset."
      />
      <SheetRow
        icon={<DeviceGlyph />}
        title="Stays on this device"
        body="The passkey never leaves this phone and we never see it — not even as a hash."
      />
    </BottomSheet>
  );
}

function FaceGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M9 10v1M15 10v1M9.5 15a3.5 3.5 0 0 0 5 0" />
    </svg>
  );
}

function DeviceGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="6" y="3" width="12" height="18" rx="2.5" />
      <path d="M10.5 18h3" />
    </svg>
  );
}
