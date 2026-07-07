'use client';

import { useEffect, useState } from 'react';
import { setPhoneForOnboarding } from '@/lib/onboarding/actions';
import {
  requestPhoneOtpForUser,
  verifyPhoneOtpForUser,
} from '@/app/(auth)/verify-phone/actions';

// ─── Phone step (client) ───────────────────────────────────────────────
//
// Two sub-states, in order:
//   1. phone-entry — shown when profiles.phone is empty (Google users).
//      Collect the cell number, write it via setPhoneForOnboarding,
//      then fall through to otp.
//   2. otp — request the OTP (existing requestPhoneOtpForUser) and
//      verify (existing verifyPhoneOtpForUser). On success, forward
//      to /onboarding for the next step.

const INPUT_CLS =
  'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none ' +
  'focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20';

type Stage = 'phone-entry' | 'otp' | 'done';

const OTP_ERROR_MSG: Record<string, string> = {
  wrong_code:          'That code doesn\'t match. Check it and try again.',
  expired:             'That code has expired. Send a new one below.',
  too_many_attempts:   'Too many wrong attempts. Send a new code below.',
  not_found:           'We don\'t have a pending code for this number. Send a new one below.',
  invalid_code_format: 'The code is a 6-digit number.',
  no_phone_on_profile: 'We don\'t have your phone on file yet — enter it above.',
  invalid_phone:       'That number isn\'t a valid South African cellphone number.',
  unauthenticated:     'Please sign in again to continue.',
  unknown:             'Something went wrong. Please try again.',
};

const START_ERROR_MSG: Record<string, string> = {
  too_soon:            'Please wait a moment before requesting another code.',
  daily_limit:         'Too many code requests for this number today. Try again tomorrow.',
  user_daily_limit:    'Too many code requests today. Try again tomorrow.',
  phone_mismatch:      'The phone on your account doesn\'t match. Please contact support.',
  sms_not_configured:  'SMS is not configured. Please contact support.',
  sms_failed:          'Couldn\'t send an SMS to that number. Try again in a moment.',
  invalid_phone:       'That number isn\'t a valid South African cellphone number.',
  no_phone_on_profile: 'We don\'t have your phone on file yet — enter it above.',
  unauthenticated:     'Please sign in again to continue.',
  invalid_user:        'Please sign in again to continue.',
  unknown:             'Something went wrong. Please try again.',
};

export default function PhoneStepClient({ existingPhone }: { existingPhone: string | null }) {
  const [stage, setStage] = useState<Stage>(existingPhone ? 'otp' : 'phone-entry');

  // Phone-entry state
  const [phone,        setPhone]        = useState(existingPhone ?? '');
  const [phoneLoading, setPhoneLoading] = useState(false);

  // OTP state
  const [code,        setCode]        = useState('');
  const [otpLoading,  setOtpLoading]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [notice,      setNotice]      = useState<string | null>(null);
  const [otpRequested, setOtpRequested] = useState(false);

  // Kick off the OTP request when we enter the otp stage (or when the
  // page loaded with an existing phone). The user can then re-request.
  useEffect(() => {
    if (stage !== 'otp' || otpRequested) return;
    void kickoffOtp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  async function handlePhoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPhoneLoading(true);

    const result = await setPhoneForOnboarding(phone.trim());
    setPhoneLoading(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    setStage('otp');
  }

  async function kickoffOtp() {
    setNotice(null);
    setError(null);
    setOtpRequested(true);
    const result = await requestPhoneOtpForUser();
    if (result.ok) {
      setNotice('We sent you a code. It arrives in about a minute.');
      return;
    }
    setError(START_ERROR_MSG[result.code] ?? START_ERROR_MSG.unknown);
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!/^\d{6}$/.test(code.trim())) {
      setError('The code is a 6-digit number.');
      return;
    }

    setOtpLoading(true);
    const result = await verifyPhoneOtpForUser(code.trim());
    setOtpLoading(false);

    if (!result.ok) {
      setError(OTP_ERROR_MSG[result.code] ?? OTP_ERROR_MSG.unknown);
      return;
    }

    setStage('done');
    // Recompute onboarding state on the server and forward.
    window.location.href = '/onboarding';
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

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2" role="alert">
            {error}
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

  // stage === 'otp' (or 'done' — the redirect races)
  return (
    <form onSubmit={handleOtpSubmit} className="space-y-4">
      <div>
        <label htmlFor="otp" className="block text-sm font-medium text-gray-700 mb-2">
          6-digit code
        </label>
        <input
          id="otp"
          type="text"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          data-testid="onboarding-phone-otp"
          placeholder="••••••"
          className={INPUT_CLS + ' text-center tracking-[0.5em]'}
        />
      </div>

      {notice && !error && (
        <p className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={otpLoading}
        data-testid="onboarding-phone-verify"
        className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {otpLoading ? 'Verifying…' : 'Continue'}
      </button>

      <div className="flex items-center justify-between text-xs">
        <button
          type="button"
          onClick={() => { setStage('phone-entry'); setOtpRequested(false); setNotice(null); setError(null); }}
          className="text-gray-500 hover:underline"
        >
          Wrong number?
        </button>
        <button
          type="button"
          onClick={kickoffOtp}
          className="text-gray-500 hover:underline"
        >
          Send a new code
        </button>
      </div>
    </form>
  );
}
