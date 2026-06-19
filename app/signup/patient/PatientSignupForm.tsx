'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { signUpPatient } from './actions';
import SalaryDayPicker from '@/components/SalaryDayPicker';
import {
  isValidEmail,
  normalizePhoneZA,
  validateSaId,
  saIdAge,
  checkPassword,
} from '@/lib/validation';
import {
  useFieldValidation,
  focusAndScrollTo,
  type FieldsSchema,
} from '@/lib/forms/useFieldValidation';

type Invitation = {
  email:        string;
  practiceName: string | null;
};

type Props = {
  invitation?: Invitation | null;
  token?:      string | null;
};

const MIN_AGE = 18;
const SA_ID_LEN = 13;

const INPUT_BASE = 'w-full rounded-lg border px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none transition-all focus:ring-2';
const INPUT_OK   = 'border-gray-300 focus:border-[#15A89E] focus:ring-[#15A89E]/20';
const INPUT_ERR  = 'border-red-400 focus:border-red-500 focus:ring-red-200';
const LABEL_CLS  = 'block text-sm font-medium text-gray-700 mb-1';

function inputClass(hasError: boolean) {
  return `${INPUT_BASE} ${hasError ? INPUT_ERR : INPUT_OK}`;
}

// SA ID surface rule: the validator's typed reason codes (length / format /
// date / citizenship / checksum) stay internal. The user sees a single
// generic message regardless of which check failed. The age gate uses its
// own message because "you're too young" is a separate concern from
// "your ID number is malformed".
const SA_ID_GENERIC_ERROR = 'Please enter a valid SA ID number.';

// ─── Field helper ────────────────────────────────────────────────────────────

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <label className={LABEL_CLS}>
      {label}
      {required && <span aria-hidden className="ml-0.5 text-red-500">*</span>}
    </label>
  );
}

// ─── Form ───────────────────────────────────────────────────────────────────

const BLANK = {
  firstName:  '',
  lastName:   '',
  email:      '',
  password:   '',
  confirm:    '',
  phone:      '',
  saIdNumber: '',
  salaryDay:  '',   // string-of-int; '' = unselected
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

  // Field declaration order = focus-on-submit order.
  const schema = useMemo<FieldsSchema<Fields>>(() => ({
    firstName: { validate: (v) => v.firstName.trim() ? null : 'First name is required.' },
    lastName:  { validate: (v) => v.lastName.trim() ? null : 'Last name is required.' },
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
    confirm:   { validate: (v) => v.password !== v.confirm ? 'Passwords don\'t match.' : null },
    phone:     {
      validate: (v) =>
        normalizePhoneZA(v.phone) ? null : 'Enter a valid South African cellphone number.',
    },
    saIdNumber: {
      validate: (v) => {
        const r = validateSaId(v.saIdNumber);
        if (!r.valid) return SA_ID_GENERIC_ERROR;
        const age = saIdAge(v.saIdNumber);
        if (age === null || age < MIN_AGE) {
          return `You must be ${MIN_AGE} or older to create a BetterNow account.`;
        }
        return null;
      },
      // No suppressLive: errors are gated only by "field has been blurred".
      // The generic single-message rule means we can show on blur regardless
      // of how many digits are typed — the user never sees length/format/
      // date/citizenship/checksum specifics anyway.
    },
    salaryDay: {
      validate: (v) => v.salaryDay ? null : 'Please choose when your salary is paid.',
    },
    termsAccepted: {
      validate: (v) => v.termsAccepted ? null : 'Please accept the betternow terms to continue.',
    },
  }), []);

  const { errors, handleBlur, validateAll } = useFieldValidation(fields, schema);

  function setText(key: Exclude<keyof Fields, 'salaryDay' | 'termsAccepted'>) {
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
      firstName:  fields.firstName.trim(),
      lastName:   fields.lastName.trim(),
      email:      emailTrimmed,
      password:   fields.password,
      phone:      fields.phone.trim(),
      saIdNumber: fields.saIdNumber.trim(),
      salaryDay:  parseInt(fields.salaryDay, 10),
      token:      token ?? undefined,
    });
    setLoading(false);

    if (result.error) {
      setSubmitError(result.error);
      return;
    }

    // Hand off to /verify-email for the 6-digit OTP. After verifyOtp
    // succeeds, the user lands on /verify-phone (the new phone-OTP
    // gate added in 0053), and on phone-verify success there hard-
    // navigates to /patient (which reads the existing
    // hnpl_invite_token cookie to associate the invitation).
    const phoneStep = '/verify-phone?next=' + encodeURIComponent('/patient');
    window.location.href = '/verify-email?email=' + encodeURIComponent(emailTrimmed) + '&next=' + encodeURIComponent(phoneStep);
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

        <div>
          <FieldLabel label="Cell number" required />
          <input
            id="patient-phone"
            type="tel"
            value={fields.phone}
            onChange={setText('phone')}
            onBlur={onBlur('phone')}
            aria-invalid={!!errors.phone}
            placeholder="082 000 0000"
            className={inputClass(!!errors.phone)}
          />
          {errors.phone && <p className="mt-1 text-xs text-red-600">{errors.phone}</p>}
        </div>

        <div>
          <FieldLabel label="SA ID number" required />
          <input
            id="patient-saIdNumber"
            type="text"
            maxLength={SA_ID_LEN}
            inputMode="numeric"
            value={fields.saIdNumber}
            onChange={setText('saIdNumber')}
            onBlur={onBlur('saIdNumber')}
            aria-invalid={!!errors.saIdNumber}
            placeholder="13-digit ID number"
            className={inputClass(!!errors.saIdNumber)}
          />
          {errors.saIdNumber && <p className="mt-1 text-xs text-red-600">{errors.saIdNumber}</p>}
        </div>

        <div id="patient-salaryDay">
          <SalaryDayPicker
            value={fields.salaryDay === '' ? null : parseInt(fields.salaryDay, 10)}
            onChange={(d) => {
              setFields(f => ({ ...f, salaryDay: String(d) }));
              handleBlur('salaryDay');
            }}
          />
          {errors.salaryDay && <p className="mt-2 text-xs text-red-600">{errors.salaryDay}</p>}
        </div>

        {/* ── Terms ───────────────────────────────────────────── */}
        <div>
          <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
            errors.termsAccepted ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-gray-50'
          }`}>
            <input
              id="patient-termsAccepted"
              type="checkbox"
              checked={fields.termsAccepted}
              onChange={(e) => setFields(f => ({ ...f, termsAccepted: e.target.checked }))}
              onBlur={onBlur('termsAccepted')}
              aria-invalid={!!errors.termsAccepted}
              className="mt-0.5 w-4 h-4 rounded border-gray-300"
            />
            <label htmlFor="patient-termsAccepted" className="text-sm text-gray-700 leading-relaxed">
              I agree to the{' '}
              <Link
                href="/legal/terms"
                target="_blank"
                rel="noopener"
                className="font-semibold underline underline-offset-2 lowercase"
                style={{ color: '#13294B' }}
              >
                betternow
              </Link>
              {' '}terms.
            </label>
          </div>
          {errors.termsAccepted && (
            <p className="mt-1 text-xs text-red-600">{errors.termsAccepted}</p>
          )}
        </div>

        {/* ── Submit-time headline ───────────────────────────── */}
        {submitError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {submitError}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {loading ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-500">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold hover:underline" style={{ color: '#13294B' }}>
          Sign in →
        </Link>
      </p>
    </>
  );
}
