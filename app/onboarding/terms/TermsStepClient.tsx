'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePendingAction } from '@/components/loading/usePendingAction';
import { acceptTerms } from './actions';

// ─── The OAuth path's agreement screen ─────────────────────────────────
//
// Deliberately the same shape as the tick inside the email signup form:
// an unticked box, both documents named and linked, and a button that
// does nothing until it is ticked. Nothing is pre-ticked and nothing is
// inferred from the fact that the visitor got this far — the whole point
// of this screen is that the agreement is given rather than assumed.

export default function TermsStepClient() {
  const [accepted, setAccepted] = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const pending = usePendingAction({ pending: loading });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!accepted) {
      setError('Please accept the betternow terms to continue.');
      return;
    }
    setLoading(true);
    const res = await acceptTerms(true);
    if (res.error) {
      setError(res.error);
      setLoading(false);
      return;
    }
    // Back to the router, which forwards to the next unfinished step.
    window.location.href = '/onboarding';
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <div className={`flex items-start gap-[13px] rounded-2xl border-[1.5px] p-4 ${
        error ? 'border-red-300 bg-red-50' : 'border-[#E2E8EE] bg-[#FBFCFD]'
      }`}>
        <input
          id="onboarding-termsAccepted"
          type="checkbox"
          checked={accepted}
          onChange={(e) => { setAccepted(e.target.checked); setError(null); }}
          data-testid="onboarding-terms-checkbox"
          className="mt-px h-5 w-5 shrink-0 rounded-md border-[1.5px] border-[#CBD6E0] accent-[#15A89E]"
        />
        <label htmlFor="onboarding-termsAccepted" className="text-[14px] leading-[1.6] text-[#41556F]">
          I agree to the{' '}
          <Link
            href="/legal/terms"
            target="_blank"
            rel="noopener"
            className="font-semibold underline underline-offset-[3px]"
            style={{ color: '#13294B' }}
          >
            Terms &amp; Conditions
          </Link>
          {' '}and{' '}
          <Link
            href="/legal/privacy"
            target="_blank"
            rel="noopener"
            className="font-semibold underline underline-offset-[3px]"
            style={{ color: '#13294B' }}
          >
            Privacy Policy
          </Link>.
        </label>
      </div>

      {error && (
        <p className="text-xs text-red-600" role="alert" data-testid="onboarding-terms-error">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!accepted || pending.disabled}
        data-testid="onboarding-terms-submit"
        className="flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all disabled:cursor-not-allowed disabled:opacity-45"
        style={{ background: '#15A89E', boxShadow: pending.disabled ? 'none' : '0 10px 22px -12px rgba(21,168,158,0.9)' }}
      >
        {pending.showLabel ? 'Saving…' : 'Next'}
      </button>
    </form>
  );
}
