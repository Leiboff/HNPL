'use client';

import { useState } from 'react';
import PhoneOtpStep from '@/app/_otp/PhoneOtpStep';
import { AUTH_WARNING_CLS } from '@/app/_components/authFormStyles';
import type {
  PhoneOtpStartResultForUser,
  PhoneOtpVerifyResultForUser,
  SkipResult,
} from './actions';

// ─── VerifyPhoneClient ───────────────────────────────────────────────────
//
// Client wrapper for /verify-phone. Owns:
//   • The PhoneOtpStep (the shared 6-cell input + resend + auto-send).
//   • The skip-with-warning branch surfaced when SMS isn't configured
//     in this environment (dev parity). The skip server action itself
//     enforces "no SMS creds" — this client just decides whether to
//     SHOW the branch.
//
// Routing on success:
//   • Verified or skipped → hard-nav to `target` (default /patient)
//     so SSR re-renders with phone_verified_at applied.

type Props = {
  phoneDisplay:  string;
  smsConfigured: boolean;
  target:        string;
  requestPhoneOtpForUser:       () => Promise<PhoneOtpStartResultForUser>;
  verifyPhoneOtpForUser:        (code: string) => Promise<PhoneOtpVerifyResultForUser>;
  skipPhoneVerificationIfNoSms: () => Promise<SkipResult>;
};

export default function VerifyPhoneClient({
  phoneDisplay,
  smsConfigured,
  target,
  requestPhoneOtpForUser,
  verifyPhoneOtpForUser,
  skipPhoneVerificationIfNoSms,
}: Props) {
  // When SMS isn't configured the page would auto-send and the
  // PhoneOtpStep would render the sms_not_configured error. That's
  // fine — but in dev we want a visible escape hatch. We show the
  // skip button below the OTP step when the env hint says SMS is
  // unconfigured.
  const [skipState, setSkipState] = useState<'idle' | 'skipping' | 'refused' | 'error'>('idle');

  async function handleSkip() {
    setSkipState('skipping');
    const r = await skipPhoneVerificationIfNoSms();
    if (r.ok) {
      window.location.href = target;
      return;
    }
    setSkipState(r.reason === 'sms_is_configured' ? 'refused' : 'error');
  }

  return (
    <div className="space-y-4">
      <PhoneOtpStep
        phoneDisplay={phoneDisplay}
        requestCode={requestPhoneOtpForUser}
        verifyCode={async (code) => {
          // Adapter — the shared component speaks in { ok, code: string }
          // shapes; both action types satisfy that contract structurally,
          // but TS wants an explicit return.
          return await verifyPhoneOtpForUser(code);
        }}
        onVerified={() => {
          // Hard nav so SSR picks up phone_verified_at on the next page.
          window.location.href = target;
        }}
        tone="onDark"
      />

      {!smsConfigured && (
        <div className={`${AUTH_WARNING_CLS} space-y-2`}>
          <p className="font-semibold">
            SMS isn’t set up in this environment.
          </p>
          <p className="text-amber-100/80">
            You can continue without phone verification — your phone will remain unverified
            until SMS is configured. This is intended for dev / staging only.
          </p>
          <button
            type="button"
            onClick={handleSkip}
            disabled={skipState === 'skipping'}
            className="mt-1 w-full rounded-full border-[1.5px] border-amber-300/40 bg-amber-400/15 px-4 py-2.5 text-[13px] font-semibold text-amber-100 transition-colors hover:bg-amber-400/25 focus:outline-none focus-visible:ring-4 focus-visible:ring-amber-300/30 disabled:opacity-60"
          >
            {skipState === 'skipping' ? 'Continuing…' : 'Continue without phone verification'}
          </button>
          {skipState === 'refused' && (
            <p className="text-xs text-amber-200">
              SMS is configured in this environment — verification cannot be skipped.
            </p>
          )}
          {skipState === 'error' && (
            <p className="text-xs text-amber-200">
              Couldn’t complete the skip. Please try again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
