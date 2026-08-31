'use client';

import { useState, type ReactNode } from 'react';
import { setPhoneForOnboarding } from '@/lib/onboarding/actions';
import {
  requestPhoneOtpForUser,
  verifyPhoneOtpForUser,
} from '@/app/(auth)/verify-phone/actions';
import PhoneOtpStep from '@/app/_otp/PhoneOtpStep';
import {
  AUTH_LABEL_CLS,
  AUTH_PRIMARY_CLS,
  AUTH_ERROR_CLS,
  authPrimaryStyle,
} from '@/app/_components/authFormStyles';

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
// OnboardingShell already provides the outer chrome + progress rail; we
// pass a `shell` render-prop to PhoneOtpStep so it renders inline
// (body + change-number action) without adding its own card.
//
// BOTH sub-stages are built like the email-confirmation screen: one
// centred, large-digit control, then the primary action pinned to the
// bottom of the shell's body region. The cell number is a 74px field
// with 28px digits, which is the same type treatment as the OTP cells
// the patient meets on the next screen and on /onboarding/verify-email.
// `normalizePhoneZA` still does the +27 conversion server-side.
//
// There WAS an on-screen numeric keypad under the field — a tray of
// ten buttons that appended to the same value. It is gone. Phones
// already raise a numeric pad for inputMode="numeric", so it duplicated
// the OS keyboard, and a bespoke keypad is not a control anyone expects
// on a web form: it read as part of the page rather than as a keyboard,
// and it made this the only screen in the journey with a widget of its
// own. Nothing else depended on it — it was aria-hidden and
// tabIndex={-1}, i.e. never in the keyboard or screen-reader path.

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
      <form onSubmit={handlePhoneSubmit} className="flex flex-1 flex-col">
        <div>
          <label htmlFor="phone" className={AUTH_LABEL_CLS}>
            Cell number
          </label>
          <input
            id="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            autoFocus
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            data-testid="onboarding-phone-input"
            placeholder="082 000 0000"
            className="h-[74px] w-full rounded-[20px] border-[1.5px] border-[var(--auth-accent)] bg-[var(--auth-fill-raised)] text-center text-[28px] font-semibold tabular-nums tracking-[0.04em] text-white outline-none transition-all placeholder:font-normal placeholder:text-white/30 focus:bg-[var(--auth-fill-hover)]"
            style={{ boxShadow: '0 0 0 4px var(--auth-accent-ring)' }}
          />
        </div>

        {phoneError && (
          <p className={`mt-4 ${AUTH_ERROR_CLS}`} role="alert">
            {phoneError}
          </p>
        )}

        {/* Pinned to the bottom of the shell's body region, exactly as
            the email-confirmation screen pins "Verify email". */}
        <button
          type="submit"
          disabled={phoneLoading}
          data-testid="onboarding-phone-submit"
          className={`mt-auto ${AUTH_PRIMARY_CLS}`}
          style={authPrimaryStyle(phoneLoading)}
        >
          {phoneLoading ? 'Saving…' : 'Send me a code'}
        </button>
      </form>
    );
  }

  // stage === 'otp' — delegate to the canonical shared PhoneOtpStep.
  // The `shell` render-prop bypasses its default card (OnboardingShell
  // already provides the step chrome). We fill the body region and pin
  // "Change number" to the bottom of it with mt-auto. `tone` puts the
  // shared step's controls into their dark-surface variant.
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
      tone="onDark"
    />
  );
}
