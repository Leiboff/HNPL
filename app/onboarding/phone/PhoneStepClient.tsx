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
// OnboardingShell already provides the outer card + progress rail; we
// pass a `shell` render-prop to PhoneOtpStep so it renders inline
// (body + change-number action) without adding its own card.
//
// The cell number is a large centred hero field (74px, 28px digits) with
// an on-screen numeric keypad below it. The keypad is a convenience
// surface — it appends to the same field the OS keyboard writes to;
// `normalizePhoneZA` still does the +27 conversion server-side
// (untouched).
//
// v3 moved both onto the dark auth surface. The keypad used to bleed to
// the edges of a white card and be clipped by its radius; with the card
// gone it is a contained panel of its own — a lighter navy (white at
// alpha over the ground) with white-at-alpha keys, so it still reads as
// a tray sitting under the field rather than as ten more buttons.

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
        <div>
          <label htmlFor="phone" className={AUTH_LABEL_CLS}>
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
            className="h-[74px] w-full rounded-[20px] border-[1.5px] border-[var(--auth-accent)] bg-[var(--auth-fill-raised)] text-center text-[28px] font-semibold tabular-nums tracking-[0.04em] text-white outline-none transition-all placeholder:font-normal placeholder:text-white/30 focus:bg-[var(--auth-fill-hover)]"
            style={{ boxShadow: '0 0 0 4px var(--auth-accent-ring)' }}
          />
        </div>

        {phoneError && (
          <p className={`mt-4 ${AUTH_ERROR_CLS}`} role="alert">
            {phoneError}
          </p>
        )}

        <div className="mt-auto flex flex-col gap-5 pt-8">
          <button
            type="submit"
            disabled={phoneLoading}
            data-testid="onboarding-phone-submit"
            className={AUTH_PRIMARY_CLS}
            style={authPrimaryStyle(phoneLoading)}
          >
            {phoneLoading ? 'Saving…' : 'Send me a code'}
          </button>

          {/* On-screen numeric keypad — a convenience surface, not the
              only way in: the field above takes the OS keyboard too, and
              every key here appends to that same controlled value. */}
          <div
            className="grid grid-cols-3 gap-[9px] rounded-[24px] border border-[var(--auth-hairline)] bg-[var(--auth-fill)] p-3.5"
            aria-hidden="true"
          >
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button
                key={d}
                type="button"
                tabIndex={-1}
                onClick={() => appendDigit(d)}
                className="flex h-[50px] items-center justify-center rounded-2xl border border-[var(--auth-hairline)] bg-[var(--auth-fill-raised)] text-[23px] font-medium text-white transition-colors hover:bg-[var(--auth-fill-hover)]"
              >
                {d}
              </button>
            ))}
            <div className="h-[50px]" />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => appendDigit('0')}
              className="flex h-[50px] items-center justify-center rounded-2xl border border-[var(--auth-hairline)] bg-[var(--auth-fill-raised)] text-[23px] font-medium text-white transition-colors hover:bg-[var(--auth-fill-hover)]"
            >
              0
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={backspace}
              className="flex h-[50px] items-center justify-center rounded-2xl text-[var(--auth-muted)] transition-colors hover:text-white"
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
