'use client';

import { useState, type ReactNode } from 'react';
import { setPhoneForOnboarding } from '@/lib/onboarding/actions';
import {
  requestPhoneOtpForUser,
  verifyPhoneOtpForUser,
} from '@/app/(auth)/verify-phone/actions';
import PhoneOtpStep from '@/app/_otp/PhoneOtpStep';

// ─── Phone step (client) — canonical OTP look/feel ─────────────────────
//
// Two sub-stages:
//   1. phone-entry — shown when profiles.phone is empty (Google users
//      arrive here without a captured phone). Collects the cell number,
//      writes via setPhoneForOnboarding, then transitions to the OTP
//      stage.
//   2. otp — delegates to the canonical <PhoneOtpStep> component
//      (@/app/_otp/PhoneOtpStep) — the same shared OTP component the
//      pre-existing /verify-phone flow and the checkout flow use.
//
// OnboardingShell already provides the outer card + progress rail; we
// pass a `shell` render-prop to PhoneOtpStep so it renders inline
// (body + change-number action) without adding its own card.
//
// v2 refresh: the cell number is a large centred hero field (74px, 28px
// digits) with an on-screen numeric keypad tray bled to the card edges.
// The keypad is a convenience surface — it appends to the same field the
// OS keyboard writes to; `normalizePhoneZA` still does the +27 conversion
// server-side (untouched).

type Stage = 'phone-entry' | 'otp';

export default function PhoneStepClient({ existingPhone }: { existingPhone: string | null }) {
  const [stage,        setStage]        = useState<Stage>(existingPhone ? 'otp' : 'phone-entry');
  const [phone,        setPhone]        = useState(existingPhone ?? '');
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [phoneError,   setPhoneError]   = useState<string | null>(null);
  // Displayed number for the OTP step. Kept separate so a "wrong number"
  // reset doesn't lose it before we transition back to phone-entry.
  const [displayPhone, setDisplayPhone] = useState(existingPhone ?? '');

  async function handlePhoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPhoneError(null);
    setPhoneLoading(true);
    const result = await setPhoneForOnboarding(phone.trim());
    setPhoneLoading(false);
    if (result.error) {
      setPhoneError(result.error);
      return;
    }
    setDisplayPhone(phone.trim());
    setStage('otp');
  }

  if (stage === 'phone-entry') {
    // The keypad writes into the same controlled value as the OS keyboard.
    // Cap the raw digit count so a fat-fingered hold can't run away.
    const appendDigit = (d: string) =>
      setPhone((p) => (p.replace(/\D/g, '').length >= 12 ? p : p + d));
    const backspace = () => setPhone((p) => p.slice(0, -1));

    return (
      <form onSubmit={handlePhoneSubmit} className="flex flex-1 flex-col">
        <div className="flex flex-col gap-[9px]">
          <label htmlFor="phone" className="text-[13px] font-medium" style={{ color: '#41556F' }}>
            Cell number
          </label>
          <input
            id="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            data-testid="onboarding-phone-input"
            placeholder="082 000 0000"
            className="h-[74px] w-full rounded-[18px] bg-white text-center text-[28px] font-semibold tabular-nums tracking-[0.04em] outline-none placeholder:text-[#A8B4C2]"
            style={{ color: '#13294B', border: '1.5px solid #15A89E', boxShadow: '0 0 0 4px rgba(21,168,158,0.13)' }}
          />
        </div>

        {phoneError && (
          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
            {phoneError}
          </p>
        )}

        <div className="mt-auto flex flex-col gap-5 pt-8">
          <button
            type="submit"
            disabled={phoneLoading}
            data-testid="onboarding-phone-submit"
            className="flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all disabled:opacity-45 disabled:cursor-not-allowed"
            style={{ background: '#15A89E', boxShadow: phoneLoading ? 'none' : '0 10px 22px -12px rgba(21,168,158,0.9)' }}
          >
            {phoneLoading ? 'Saving…' : 'Send me a code'}
          </button>

          {/* On-screen numeric keypad — a convenience surface bled to the
              card edges. The card's overflow-hidden clips it to the 28px
              radius. It appends to the same field the OS keyboard uses. */}
          <div
            className="grid grid-cols-3 gap-[9px]"
            style={{ margin: '0 -28px -32px', padding: '16px 18px 22px', background: '#F1F5F6', borderTop: '1px solid #E4EAEF' }}
            aria-hidden="true"
          >
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button
                key={d}
                type="button"
                tabIndex={-1}
                onClick={() => appendDigit(d)}
                className="flex h-[50px] items-center justify-center rounded-xl bg-white text-[23px] font-medium"
                style={{ color: '#13294B', boxShadow: '0 1px 1px rgba(15,31,58,0.10)' }}
              >
                {d}
              </button>
            ))}
            <div className="h-[50px]" />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => appendDigit('0')}
              className="flex h-[50px] items-center justify-center rounded-xl bg-white text-[23px] font-medium"
              style={{ color: '#13294B', boxShadow: '0 1px 1px rgba(15,31,58,0.10)' }}
            >
              0
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={backspace}
              className="flex h-[50px] items-center justify-center"
              style={{ color: '#5B6E86' }}
            >
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 5H9.5L3 12l6.5 7H20a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z" />
                <path d="M16 9.5l-5 5" />
                <path d="M11 9.5l5 5" />
              </svg>
            </button>
          </div>
        </div>
      </form>
    );
  }

  // stage === 'otp' — delegate to the canonical shared PhoneOtpStep.
  // The `shell` render-prop bypasses its default card (OnboardingShell
  // already provides one). We fill the card body and pin "Change number"
  // to the bottom with mt-auto.
  const inlineShell = (body: ReactNode, actions: ReactNode): ReactNode => (
    <div className="flex flex-1 flex-col gap-5">
      {body}
      {actions ? <div className="mt-auto pt-4">{actions}</div> : null}
    </div>
  );

  return (
    <PhoneOtpStep
      phoneDisplay={displayPhone}
      requestCode={requestPhoneOtpForUser}
      verifyCode={verifyPhoneOtpForUser}
      onVerified={() => { window.location.href = '/onboarding'; }}
      onChangeNumber={() => setStage('phone-entry')}
      shell={inlineShell}
    />
  );
}
