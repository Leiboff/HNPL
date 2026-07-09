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
//      Same 6-cell OtpInput, same 30s resend cooldown, same coded-
//      error mapping.
//
// OnboardingShell already provides the outer card + progress bar; we
// pass a `shell` render-prop to PhoneOtpStep so it renders inline
// (body + change-number action) without adding its own card.

const INPUT_CLS =
  'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none ' +
  'focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20';

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
    return (
      <form onSubmit={handlePhoneSubmit} className="space-y-4">
        <div>
          <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
            Cell number
          </label>
          <input
            id="phone"
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            data-testid="onboarding-phone-input"
            placeholder="082 000 0000"
            className={INPUT_CLS}
          />
        </div>

        {phoneError && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2" role="alert">
            {phoneError}
          </p>
        )}

        <button
          type="submit"
          disabled={phoneLoading}
          data-testid="onboarding-phone-submit"
          className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 transition-all hover:shadow-lg"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {phoneLoading ? 'Saving…' : 'Send me a code'}
        </button>
      </form>
    );
  }

  // stage === 'otp' — delegate to the canonical shared PhoneOtpStep.
  // The `shell` render-prop bypasses its default card (OnboardingShell
  // already provides one) — we just return body + actions inline.
  const inlineShell = (body: ReactNode, actions: ReactNode): ReactNode => (
    <div className="space-y-5">
      {body}
      {actions}
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
