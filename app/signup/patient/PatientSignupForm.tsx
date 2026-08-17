'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { signUpPatient } from './actions';
import {
  isValidEmail,
  checkPassword,
} from '@/lib/validation';
import {
  useFieldValidation,
  focusAndScrollTo,
  type FieldsSchema,
} from '@/lib/forms/useFieldValidation';
import ContinueWithGoogleButton from '@/app/_components/ContinueWithGoogleButton';
import { usePendingAction } from '@/components/loading/usePendingAction';

// ─── PatientSignupForm — account-only ─────────────────────────────────
//
// After the stepped-onboarding pass, this form collects ONLY the
// fields needed to create the auth user. Phone, SA ID, and salary
// date now belong to the /onboarding flow — captured with a progress
// bar, resumable, gated server-side. Google users skip this form
// entirely and land in /onboarding directly.
//
// The invitation banner + hnpl_invite_token cookie handoff are
// unchanged: a patient arriving here via a practice's checkout link
// still gets their invitation cookie set and processed by the
// middleware after they finish onboarding.

type Invitation = {
  email:        string;
  practiceName: string | null;
};

type Props = {
  invitation?: Invitation | null;
  token?:      string | null;
};

const INPUT_BASE = 'h-[50px] w-full rounded-[14px] border-[1.5px] px-[14px] text-[15px] text-[#13294B] outline-none transition-all placeholder:text-[#A8B4C2]';
const INPUT_OK   = 'border-[#E2E8EE] bg-[#FBFCFD] focus:border-[#15A89E] focus:bg-white focus:ring-4 focus:ring-[#15A89E]/15';
const INPUT_ERR  = 'border-red-400 bg-white focus:border-red-500 focus:ring-4 focus:ring-red-200';
const LABEL_CLS  = 'block text-[13px] font-medium text-[#41556F] mb-[7px]';

function inputClass(hasError: boolean) {
  return `${INPUT_BASE} ${hasError ? INPUT_ERR : INPUT_OK}`;
}

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <label className={LABEL_CLS}>
      {label}
      {required && <span aria-hidden className="ml-0.5 text-[#E05252]">*</span>}
    </label>
  );
}

const BLANK = {
  firstName:     '',
  lastName:      '',
  email:         '',
  password:      '',
  confirm:       '',
  termsAccepted: false,
};

type Fields = typeof BLANK;

export default function PatientSignupForm({ invitation, token }: Props) {
  const [fields, setFields] = useState<Fields>({
    ...BLANK,
    email: invitation?.email ?? '',
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);
  // Mirrors the flag above for PRESENTATION only — the flag and the call
  // it guards are untouched. pending.disabled follows it immediately
  // (double-tap safety is never delayed); pending.showLabel waits out the
  // flash threshold. See components/loading/usePendingAction.ts.
  const pending = usePendingAction({ pending: loading });

  // Field declaration order = focus-on-submit order.
  const schema = useMemo<FieldsSchema<Fields>>(() => ({
    firstName: { validate: (v) => v.firstName.trim() ? null : 'First name is required.' },
    lastName:  { validate: (v) => v.lastName.trim()  ? null : 'Last name is required.' },
    email:     { validate: (v) => isValidEmail(v.email) ? null : 'Enter a valid email address.' },
    password:  {
      validate: (v) => {
        if (v.password.length < 8) return 'Password must be at least 8 characters.';
        const pwd = checkPassword(v.password, v.email);
        if (!pwd.ok) {
          return pwd.reason === 'contains_email_local_part'
            ? 'Please choose a password that doesn\'t contain your email address.'
            : 'That password is too common. Please choose a less guessable one.';
        }
        return null;
      },
    },
    confirm:       { validate: (v) => v.password !== v.confirm ? 'Passwords don\'t match.' : null },
    termsAccepted: { validate: (v) => v.termsAccepted ? null : 'Please accept the betternow terms to continue.' },
  }), []);

  const { errors, handleBlur, validateAll } = useFieldValidation(fields, schema);

  function setText(key: Exclude<keyof Fields, 'termsAccepted'>) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setFields(f => ({ ...f, [key]: e.target.value }));
  }
  const onBlur = (key: keyof Fields) => () => handleBlur(key);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const { ok, firstInvalid } = validateAll();
    if (!ok) {
      setSubmitError('Please complete the required fields highlighted below.');
      if (firstInvalid) {
        const id = `patient-${String(firstInvalid)}`;
        requestAnimationFrame(() => focusAndScrollTo(id));
      }
      return;
    }

    setLoading(true);
    const emailTrimmed = fields.email.trim();
    const result = await signUpPatient({
      firstName:     fields.firstName.trim(),
      lastName:      fields.lastName.trim(),
      email:         emailTrimmed,
      password:      fields.password,
      token:         token ?? undefined,
      termsAccepted: fields.termsAccepted,
    });
    setLoading(false);

    if (result.error) {
      setSubmitError(result.error);
      return;
    }

    // Hand off to the onboarding tree. /onboarding/verify-email is
    // reachable pre-session (reads email from ?email= param). After
    // verifyOtp succeeds there, the form hard-navigates to /onboarding,
    // which forwards to the next unfinished step (phone). Every
    // subsequent step lives inside the /onboarding tree with the
    // shared progress bar.
    window.location.href =
      '/onboarding/verify-email?email=' + encodeURIComponent(emailTrimmed);
  }

  return (
    <>
      {invitation && (
        <div className="mb-6 rounded-xl border px-4 py-4" style={{ borderColor: 'rgba(19,41,75,.15)', background: 'rgba(19,41,75,.04)' }}>
          <p className="text-sm font-medium" style={{ color: '#13294B' }}>
            {invitation.practiceName
              ? `${invitation.practiceName} has sent you a payment plan.`
              : 'You have been sent a payment plan.'}
          </p>
          <p className="mt-0.5 text-sm text-gray-600">Register to view and accept it.</p>
        </div>
      )}

      {/* Continue with Google — patient signup shortcut. Google users
          skip the email + password step; every OTHER onboarding step
          (email confirmed via Google, ID + phone + salary date + credit
          + affordability check) still applies via the standard patient
          surfaces after they land in /patient. */}
      <div className="mb-[18px] space-y-[18px]" data-testid="patient-signup-google-block">
        <ContinueWithGoogleButton label="Continue with Google" />
        <div className="relative flex items-center gap-[14px]">
          <div className="grow border-t border-[#E7EDF1]" />
          <span className="text-xs text-[#93A2B4]">or with email</span>
          <div className="grow border-t border-[#E7EDF1]" />
        </div>
      </div>

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel label="First name" required />
            <input
              id="patient-firstName"
              type="text"
              value={fields.firstName}
              onChange={setText('firstName')}
              onBlur={onBlur('firstName')}
              aria-invalid={!!errors.firstName}
              placeholder="Jane"
              className={inputClass(!!errors.firstName)}
            />
            {errors.firstName && <p className="mt-1 text-xs text-red-600">{errors.firstName}</p>}
          </div>
          <div>
            <FieldLabel label="Last name" required />
            <input
              id="patient-lastName"
              type="text"
              value={fields.lastName}
              onChange={setText('lastName')}
              onBlur={onBlur('lastName')}
              aria-invalid={!!errors.lastName}
              placeholder="Smith"
              className={inputClass(!!errors.lastName)}
            />
            {errors.lastName && <p className="mt-1 text-xs text-red-600">{errors.lastName}</p>}
          </div>
        </div>

        <div>
          <FieldLabel label="Email address" required />
          <input
            id="patient-email"
            type="email"
            value={fields.email}
            onChange={invitation ? undefined : setText('email')}
            onBlur={invitation ? undefined : onBlur('email')}
            readOnly={!!invitation}
            aria-invalid={!!errors.email}
            placeholder="jane@example.com"
            className={`${inputClass(!!errors.email)} ${invitation ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : ''}`}
          />
          {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email}</p>}
        </div>

        <div>
          <FieldLabel label="Password" required />
          <input
            id="patient-password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={fields.password}
            onChange={setText('password')}
            onBlur={onBlur('password')}
            aria-invalid={!!errors.password}
            placeholder="At least 8 characters"
            className={inputClass(!!errors.password)}
          />
          {errors.password && <p className="mt-1 text-xs text-red-600">{errors.password}</p>}
        </div>

        <div>
          <FieldLabel label="Confirm password" required />
          <input
            id="patient-confirm"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={fields.confirm}
            onChange={setText('confirm')}
            onBlur={onBlur('confirm')}
            aria-invalid={!!errors.confirm}
            placeholder="Repeat your password"
            className={inputClass(!!errors.confirm)}
          />
          {errors.confirm && <p className="mt-1 text-xs text-red-600">{errors.confirm}</p>}
        </div>

        {/* ── Terms ───────────────────────────────────────────── */}
        <div>
          <div className={`flex items-start gap-[13px] rounded-2xl border-[1.5px] p-4 ${
            errors.termsAccepted ? 'border-red-300 bg-red-50' : 'border-[#E2E8EE] bg-[#FBFCFD]'
          }`}>
            <input
              id="patient-termsAccepted"
              type="checkbox"
              checked={fields.termsAccepted}
              onChange={(e) => setFields(f => ({ ...f, termsAccepted: e.target.checked }))}
              onBlur={onBlur('termsAccepted')}
              aria-invalid={!!errors.termsAccepted}
              className="mt-px h-5 w-5 shrink-0 rounded-md border-[1.5px] border-[#CBD6E0] accent-[#15A89E]"
            />
            <label htmlFor="patient-termsAccepted" className="text-[14px] leading-[1.6] text-[#41556F]">
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
          {errors.termsAccepted && (
            <p className="mt-1 text-xs text-red-600">{errors.termsAccepted}</p>
          )}
        </div>

        {submitError && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {submitError}
          </div>
        )}

        <button
          type="submit"
          disabled={pending.disabled}
          className="flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all disabled:opacity-45 disabled:cursor-not-allowed"
          style={{ background: '#15A89E', boxShadow: pending.disabled ? 'none' : '0 10px 22px -12px rgba(21,168,158,0.9)' }}
        >
          {pending.showLabel ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-6 text-center text-[14px] text-[#6B7C93]">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold hover:underline" style={{ color: '#13294B' }}>
          Sign in →
        </Link>
      </p>
    </>
  );
}
