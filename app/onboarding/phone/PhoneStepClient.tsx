'use client';

import { useRef, useState, type ReactNode } from 'react';
import { setPhoneForOnboarding } from '@/lib/onboarding/actions';
import {
  requestPhoneOtpForUser,
  verifyPhoneOtpForUser,
} from '@/app/(auth)/verify-phone/actions';
import PhoneOtpStep from '@/app/_otp/PhoneOtpStep';
import {
  toNationalDigitsZA,
  formatNationalZA,
  nationalToE164ZA,
  ZA_DIAL_CODE,
} from '@/lib/validation';
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
//
// ── The number is entered in +27 form ──────────────────────────────────
//
// The field SHOWS "+27" as fixed chrome and holds only the nine national
// digits, grouped as "82 123 4567". State is the digits; the displayed
// string is derived from them, so the two cannot disagree.
//
// A leading 0 is dropped as it is typed. South Africans write their
// number as 082…, but that 0 is a national trunk prefix and is not part
// of the number — "+27 082…" is not a phone number anywhere. Dropping it
// silently is better than accepting it and erroring on submit. The same
// pass peels a pasted "+27", "27" or "0027", so pasting a number from a
// contact card lands correctly whatever form it is in.
//
// All of that lives in lib/validation/phone.ts next to the canonical
// normalizePhoneZA — which is still what validates the number, on the
// server, when setPhoneForOnboarding receives the E.164 form this
// submits. Nothing here validates; a field must let someone type a
// half-finished number without being told it is wrong.
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

/**
 * How the number reads once it leaves the field — on the OTP screen's
 * "We sent a 6-digit code to …" line. Same grouping as the field, so the
 * number the patient just typed is recognisably the number we are
 * texting. The stored value is still bare E.164; this is display only.
 */
function displayNumber(nationalDigits: string): string {
  return `${ZA_DIAL_CODE} ${formatNationalZA(nationalDigits)}`;
}

export default function PhoneStepClient({
  existingPhone,
  nextPath,
}: {
  existingPhone: string | null;
  /**
   * Where a verified phone goes next — the NEXT STEP'S path, resolved by
   * the page from the path-fixed step list, not "/onboarding".
   *
   * Sending everyone back to the router cost a whole extra server
   * execution per step: getUser() is a network round trip to Supabase
   * Auth, then a profile read, then a 307, and then the step page did
   * getUser() and the read again. See pathAfterStep() in
   * lib/onboarding/state.ts.
   */
  nextPath: string;
}) {
  const [stage,        setStage]        = useState<Stage>(existingPhone ? 'otp' : 'phone-entry');
  // The NINE national digits, never the dial code and never the trunk 0.
  // Seeded from a stored number so "Change number" returns to a filled
  // field rather than an empty one.
  const [national,     setNational]     = useState(() => toNationalDigitsZA(existingPhone));
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [phoneError,   setPhoneError]   = useState<string | null>(null);
  // Displayed number for the OTP step. Kept separate so a "wrong number"
  // reset doesn't lose it before we transition back to phone-entry.
  const [displayPhone, setDisplayPhone] = useState(
    () => (existingPhone ? displayNumber(toNationalDigitsZA(existingPhone)) : ''),
  );
  // The field is a styled row, not a bare input — tapping anywhere in it
  // (including the "+27") must land in the input.
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handlePhoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPhoneError(null);
    setPhoneLoading(true);
    // E.164 candidate. normalizePhoneZA on the server is the gate: a
    // short number comes back as "Enter a valid South African
    // cellphone number." rather than being submitted as-is.
    const e164 = nationalToE164ZA(national);
    const result = await setPhoneForOnboarding(e164);
    setPhoneLoading(false);
    if (result.error) {
      setPhoneError(result.error);
      return;
    }
    setDisplayPhone(displayNumber(national));
    setStage('otp');
  }

  if (stage === 'phone-entry') {
    return (
      <form onSubmit={handlePhoneSubmit} className="flex flex-1 flex-col">
        <div>
          <label htmlFor="phone" className={AUTH_LABEL_CLS}>
            Cell number
          </label>

          {/* The dial code and the digits are one number, so they are one
              object: a field-shaped row, centred as a group, with the
              input sized to the nine digits it will hold. The input keeps
              its own left alignment inside that box so the digits start
              at the same x whether the field is empty or full — centring
              them there would make the number crawl sideways as it is
              typed. */}
          <div
            onClick={() => inputRef.current?.focus()}
            className="flex h-[74px] w-full items-center justify-center gap-2.5 rounded-[20px] border-[1.5px] border-[var(--auth-accent)] bg-[var(--auth-fill-raised)] transition-colors focus-within:bg-[var(--auth-fill-hover)]"
            style={{ boxShadow: '0 0 0 4px var(--auth-accent-ring)' }}
          >
            <span
              aria-hidden
              className="text-[28px] font-semibold tabular-nums text-[var(--auth-muted)]"
            >
              {ZA_DIAL_CODE}
            </span>
            <input
              id="phone"
              ref={inputRef}
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              autoFocus
              value={formatNationalZA(national)}
              onChange={(e) => setNational(toNationalDigitsZA(e.target.value))}
              // No maxLength: a pasted "+27 82 123 4567" is longer than
              // the displayed string, and the browser would truncate it
              // before onChange could peel the prefix. The slice in
              // toNationalDigitsZA is the real cap.
              aria-describedby="phone-dial-code-hint"
              data-testid="onboarding-phone-input"
              placeholder="82 000 0000"
              className="w-[11.5ch] bg-transparent text-left text-[28px] font-semibold tabular-nums tracking-[0.04em] text-white outline-none placeholder:font-normal placeholder:text-white/30"
            />
          </div>

          {/* The "+27" is visual, so it is invisible to a screen reader.
              This says the same thing in words, and says the part the
              sighted user infers from the placeholder too. */}
          <span id="phone-dial-code-hint" className="sr-only">
            South African number, country code +27. Enter your number without its leading zero.
          </span>
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
      onVerified={() => { window.location.href = nextPath; }}
      onChangeNumber={() => setStage('phone-entry')}
      shell={inlineShell}
      tone="onDark"
    />
  );
}
