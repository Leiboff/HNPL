'use client';

import { useState } from 'react';
import Link from 'next/link';
import { continueOnboardingDraft, startOverOnboardingDraft } from '@/lib/onboarding/actions';

// ─── Welcome-back resume interstitial ───────────────────────────────────
//
// Rendered by the /onboarding router (app/onboarding/page.tsx) instead of
// silently forwarding to the next unfinished step, whenever an in-progress
// draft exists and this load ISN'T a direct continuation of a step the
// patient just finished. Two jobs:
//
//   1. Confirm identity before resuming anything — shows the masked
//      verified email (and phone, once verified) the draft belongs to,
//      so a different person picking up a shared, still-logged-in
//      device sees whose application this is before either button does
//      anything. Neither button acts silently.
//   2. Offer "Start over" for a genuinely expired (30+ day) draft with NO
//      continue option at all.

const POPPINS = 'var(--font-poppins), Poppins, system-ui, sans-serif';

type Props = {
  expired:     boolean;
  maskedEmail: string | null;
  maskedPhone: string | null;
};

export default function WelcomeBackInterstitial({ expired, maskedEmail, maskedPhone }: Props) {
  const [loading, setLoading] = useState<'continue' | 'start-over' | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  async function handleContinue() {
    setError(null);
    setLoading('continue');
    const result = await continueOnboardingDraft();
    if (result.error) {
      setError(result.error);
      setLoading(null);
      return;
    }
    window.location.href = result.nextPath ?? '/onboarding';
  }

  async function handleStartOver() {
    setError(null);
    setLoading('start-over');
    const result = await startOverOnboardingDraft();
    if (result.error) {
      setError(result.error);
      setLoading(null);
      return;
    }
    window.location.href = result.nextPath ?? '/onboarding';
  }

  return (
    <div className="min-h-full flex justify-center px-4 py-8 sm:py-14" style={{ background: '#E9EFF1' }}>
      <div className="w-full max-w-[428px]">
        <section
          className="flex flex-col gap-6 overflow-hidden rounded-[28px] border bg-white"
          style={{
            borderColor: 'rgba(19,41,75,0.07)',
            boxShadow:   '0 24px 48px -28px rgba(15,31,58,.28), 0 2px 6px rgba(15,31,58,.04)',
            padding:     '30px 28px 32px',
          }}
        >
          <Link href="/" className="text-[22px] font-bold tracking-tight" style={{ fontFamily: POPPINS }}>
            <span style={{ color: '#13294B' }}>better</span>
            <span style={{ color: '#15A89E' }}>now</span>
          </Link>

          <div>
            <h1
              className="text-[28px] font-semibold leading-[1.18] tracking-[-0.025em]"
              style={{ color: '#13294B', fontFamily: POPPINS }}
            >
              {expired ? 'Your application expired' : 'Welcome back'}
            </h1>
            <p className="mt-2.5 text-[15px] leading-[1.55]" style={{ color: '#6B7C93' }}>
              {expired
                ? 'It\'s been over 30 days since you last worked on this application, so we\'ve cleared it. Start a fresh one below.'
                : 'You have an application in progress. Continue where you left off, or start over.'}
            </p>
          </div>

          {(maskedEmail || maskedPhone) && (
            <div
              className="rounded-2xl border-[1.5px] px-4 py-3.5"
              style={{ borderColor: '#E2E8EE', background: '#FBFCFD' }}
              data-testid="onboarding-resume-identity"
            >
              <p className="text-[12px] font-medium uppercase tracking-wider" style={{ color: '#8496AA' }}>
                This application belongs to
              </p>
              <p className="mt-1 text-[15px] font-semibold tabular-nums" style={{ color: '#13294B' }}>
                {maskedEmail}
                {maskedEmail && maskedPhone && <span style={{ color: '#8496AA' }}> · </span>}
                {maskedPhone}
              </p>
              <p className="mt-1 text-[12px]" style={{ color: '#8496AA' }}>
                Not you? Choose &ldquo;Start over&rdquo; below, or log out from a different account.
              </p>
            </div>
          )}

          {error && (
            <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}

          <div className="flex flex-col gap-3">
            {!expired && (
              <button
                type="button"
                onClick={handleContinue}
                disabled={loading !== null}
                data-testid="onboarding-resume-continue"
                className="flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all disabled:opacity-45 disabled:cursor-not-allowed"
                style={{ background: '#15A89E', boxShadow: loading ? 'none' : '0 10px 22px -12px rgba(21,168,158,0.9)' }}
              >
                {loading === 'continue' ? 'Continuing…' : 'Continue your application'}
              </button>
            )}

            <button
              type="button"
              onClick={handleStartOver}
              disabled={loading !== null}
              data-testid="onboarding-resume-start-over"
              className="flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold transition-all disabled:opacity-45 disabled:cursor-not-allowed"
              style={{
                color:      '#41556F',
                background: '#F1F5F6',
              }}
            >
              {loading === 'start-over' ? 'Starting over…' : 'Start over'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
