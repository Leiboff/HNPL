'use client';

import { useState } from 'react';
import { usePasskeys, passkeyErrorMessage } from '@/lib/hooks/usePasskeys';
import { dismissPasskeyPrompt } from './passkey-actions';

/**
 * Post-first-login passkey nudge — rendered by app/patient/page.tsx whenever
 * the patient hasn't yet capped out their dismissal allowance. We self-hide
 * if the patient already has a passkey (the parent can't easily check that
 * server-side without an admin Supabase client).
 *
 * Rules from the brief:
 *   • One tap to register, one to dismiss.
 *   • Treat a cancelled WebAuthn ceremony as a dismissal.
 *   • Re-prompt at most once after 30 days (enforced via dismissal_count in
 *     the action + the parent's render check).
 *   • Never block portal access — we render null while loading and let the
 *     rest of the page paint.
 */
export default function PasskeySetupCard() {
  const { passkeys, loading, supported, register } = usePasskeys();
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done,  setDone]  = useState(false);

  // Browser without WebAuthn — render nothing rather than a card the user
  // can't act on. We also unmount once registration succeeds.
  if (!supported || done) return null;
  // While we don't know whether the user already has a passkey, don't paint
  // the card — that avoids flashing it for users who already registered.
  if (loading) return null;
  if (passkeys.length > 0) return null;

  async function handleRegister() {
    setBusy(true);
    setError(null);
    const { ok, error: code } = await register();
    setBusy(false);
    if (ok) {
      setDone(true);
      return;
    }
    if (code === 'user_cancelled') {
      // Per brief: cancelled ceremony counts as a dismissal.
      await dismissPasskeyPrompt();
      setDone(true);
      return;
    }
    setError(code ? passkeyErrorMessage(code) : 'Something went wrong. Please try again.');
  }

  async function handleDismiss() {
    setBusy(true);
    await dismissPasskeyPrompt();
    setBusy(false);
    setDone(true);
  }

  return (
    <div
      className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white p-5 shadow-sm"
      role="region"
      aria-label="Passkey setup"
    >
      <p
        className="text-xs font-semibold uppercase tracking-widest"
        style={{ color: '#13294B', opacity: 0.6 }}
      >
        Sign in faster
      </p>
      <p className="mt-2 text-base font-semibold" style={{ color: '#13294B' }}>
        Use Face ID or your fingerprint next time
      </p>
      <p className="mt-1 text-sm text-gray-500">
        Save a passkey on this device so you can skip the password.
      </p>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={handleRegister}
          disabled={busy}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {busy ? 'Setting up…' : 'Add a passkey'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={busy}
          className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
