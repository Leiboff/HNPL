'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createPractice, getPracticeInvitationByToken } from './actions';
import { isValidEmail, normalizePhoneZA, checkPassword } from '@/lib/validation';
import {
  useFieldValidation,
  focusAndScrollTo,
  type FieldsSchema,
} from '@/lib/forms/useFieldValidation';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import { parseAddressComponents } from '@/lib/maps/places';
import { usePendingAction } from '@/components/loading/usePendingAction';
import SpecialtyOptions from '@/components/SpecialtyOptions';

// ─── Constants ────────────────────────────────────────────────────────────────

const INPUT_BASE =
  'w-full rounded-lg border px-3 py-2.5 text-sm text-gray-900 ' +
  'placeholder-gray-400 outline-none transition-all bg-white ' +
  'focus:ring-2';
const INPUT_OK =
  'border-gray-300 focus:border-[#15A89E] focus:ring-[#15A89E]/20';
const INPUT_ERR =
  'border-red-400 focus:border-red-500 focus:ring-red-200';

function inputClass(hasError: boolean) {
  return `${INPUT_BASE} ${hasError ? INPUT_ERR : INPUT_OK}`;
}

const LABEL = 'block text-sm font-medium text-gray-700 mb-1';

// ─── Field / Section helpers ─────────────────────────────────────────────────

function Field({
  label, hint, required, error, children,
}: {
  label:    string;
  hint?:    string;
  required?: boolean;
  error?:   string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className={LABEL}>
        {label}
        {required && <span aria-hidden className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
      {error
        ? <p className="mt-1 text-xs text-red-600">{error}</p>
        : hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-gray-500">{description}</p>}
      </div>
      {children}
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const BLANK = {
  // About the practice
  practiceName:      '',
  specialty:         '',
  practiceRegNumber: '',
  // Address — populated by a Places (New) selection. The picker writes
  // addressLine1 (= formattedAddress), suburb/city/province/postalCode
  // (parsed from addressComponents), and latitude/longitude (from the
  // place's location). addressLine2 is the only field the user types
  // by hand (Places doesn't capture unit/suite).
  addressLine1:      '',
  addressLine2:      '',
  suburb:            '',
  city:              '',
  province:          '',
  postalCode:        '',
  latitude:          null as number | null,
  longitude:         null as number | null,

  // Admin
  firstName:         '',
  lastName:          '',
  email:             '',
  password:          '',
  confirm:           '',
  phone:             '',

  // Agreement
  agreementAccepted: false,
};

type Fields = typeof BLANK;

// Field declaration order = focus-on-submit order. Keep this list in sync
// with the JSX below — the hook walks it top-to-bottom to find the first
// invalid field. Optional fields (practiceRegNumber, addressLine2) are
// omitted: they have no validator.
const SCHEMA: FieldsSchema<Fields> = {
  practiceName: { validate: (v) => v.practiceName.trim() ? null : 'Practice name is required.' },
  specialty:    { validate: (v) => v.specialty ? null : 'Specialty is required.' },
  // Address is required ONLY via the Places picker — confirmed when
  // addressLine1 (formatted) AND latitude are populated. Typing without
  // selecting a suggestion leaves latitude null and fails validation.
  addressLine1: {
    validate: (v) =>
      v.addressLine1.trim() && v.latitude != null
        ? null
        : 'Select an address from the dropdown.',
  },
  firstName:    { validate: (v) => v.firstName.trim() ? null : 'First name is required.' },
  lastName:     { validate: (v) => v.lastName.trim() ? null : 'Last name is required.' },
  email:        { validate: (v) => isValidEmail(v.email) ? null : 'Enter a valid email address.' },
  password:     {
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
  confirm:      { validate: (v) => v.password !== v.confirm ? 'Passwords don\'t match.' : null },
  phone:        {
    validate: (v) =>
      normalizePhoneZA(v.phone, { allowLandline: true })
        ? null
        : 'Enter a valid South African phone number.',
  },
  agreementAccepted: {
    validate: (v) =>
      v.agreementAccepted ? null : 'Please accept the Provider Agreement to continue.',
  },
};

export default function PracticeSignupPage() {
  const [fields,      setFields]      = useState<Fields>(BLANK);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);
  // Mirrors the flag above for PRESENTATION only — the flag and the call
  // it guards are untouched. pending.disabled follows it immediately
  // (double-tap safety is never delayed); pending.showLabel waits out the
  // flash threshold. See components/loading/usePendingAction.ts.
  const pending = usePendingAction({ pending: loading });
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [emailLocked, setEmailLocked] = useState(false);

  const schema = useMemo(() => SCHEMA, []);
  const { errors, handleBlur, validateAll } = useFieldValidation(fields, schema);

  // If the URL has ?token=, look it up via the SECURITY DEFINER RPC and
  // pre-fill the form. Wrap in an async IIFE so we're not calling
  // setState directly inside the effect (matches PushSoftAsk pattern).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) return;
    void (async () => {
      const pre = await getPracticeInvitationByToken(token);
      if (!pre) return;
      setInviteToken(token);
      setEmailLocked(true);
      setFields(prev => ({
        ...prev,
        email:         pre.email          ?? prev.email,
        practiceName:  pre.practice_name  ?? prev.practiceName,
        firstName:     pre.contact_first_name ?? prev.firstName,
        lastName:      pre.contact_last_name  ?? prev.lastName,
        phone:         pre.phone          ?? prev.phone,
        specialty:     pre.specialty      ?? prev.specialty,
        // Address prefill: street/suburb/city/province may all be blank
        // on legacy invites — keep the field defaults intact when the
        // token doesn't carry an address.
        addressLine1:  pre.street_address ?? prev.addressLine1,
        suburb:        pre.suburb         ?? prev.suburb,
        city:          pre.city           ?? prev.city,
        province:      pre.province       ?? prev.province,
      }));
    })();
  }, []);

  function setText(key: Exclude<keyof Fields, 'agreementAccepted'>) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
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
        const id = `practice-${String(firstInvalid)}`;
        requestAnimationFrame(() => focusAndScrollTo(id));
      }
      return;
    }

    setLoading(true);
    const result = await createPractice({
      practiceName:       fields.practiceName,
      specialty:          fields.specialty,
      practiceRegNumber:  fields.practiceRegNumber,
      addressLine1:       fields.addressLine1,
      addressLine2:       fields.addressLine2,
      suburb:             fields.suburb,
      city:               fields.city,
      province:           fields.province,
      postalCode:         fields.postalCode,
      latitude:           fields.latitude,
      longitude:          fields.longitude,
      firstName:          fields.firstName,
      lastName:           fields.lastName,
      email:              fields.email,
      password:           fields.password,
      phone:              fields.phone,
      agreementAccepted:  fields.agreementAccepted,
      inviteToken:        inviteToken ?? undefined,
    });
    setLoading(false);

    if (result.error) {
      setSubmitError(result.error);
    } else if (result.needsVerification && result.email) {
      // Hand off to /verify-email for the 6-digit OTP. After verifyOtp
      // succeeds, the user lands on /practice — the trading gate will
      // show the "awaiting approval" panel until an admin approves them.
      window.location.href = '/verify-email?email='
        + encodeURIComponent(result.email)
        + '&next=' + encodeURIComponent('/practice');
    } else {
      window.location.href = '/practice';
    }
  }

  return (
    <div
      className="min-h-screen py-12 px-4"
      style={{
        background: '#f7fbfb',
        backgroundImage:
          'radial-gradient(58% 48% at 84% 0%, rgba(21,168,158,.12), transparent 70%), ' +
          'radial-gradient(48% 42% at 4% 90%, rgba(19,41,75,.07), transparent 70%)',
      }}
    >
      <div className="mx-auto max-w-xl">

        {/* Header + prominent already-registered log-in link. The
            link is visible without scrolling on mobile — placed in
            the top-right rather than buried at the bottom. */}
        <div className="mb-6 flex items-start justify-between gap-3">
          <Link
            href="/"
            className="inline-block text-2xl font-bold tracking-tight"
            style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
          </Link>
          <Link
            href="/login"
            data-testid="practice-signup-login-cross-link"
            className="text-sm font-semibold rounded-lg border border-[rgba(19,41,75,.12)] bg-white px-3 py-1.5 hover:bg-gray-50"
            style={{ color: '#13294B' }}
          >
            Log in
          </Link>
        </div>

        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-gray-900" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
            Register your practice
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Takes a couple of minutes. Banking and team setup happen in your dashboard after we&apos;ve approved your practice.
          </p>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          noValidate
          className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 space-y-8"
        >

          {/* ── About the practice ─────────────────────────────── */}
          <Section title="About your practice">
            <Field label="Practice name" required error={errors.practiceName ?? null}>
              <input
                id="practice-practiceName"
                className={inputClass(!!errors.practiceName)}
                type="text"
                value={fields.practiceName}
                onChange={setText('practiceName')}
                onBlur={onBlur('practiceName')}
                aria-invalid={!!errors.practiceName}
                placeholder="City Medical Centre"
              />
            </Field>
            <Field label="Specialty" required error={errors.specialty ?? null}>
              <select
                id="practice-specialty"
                className={inputClass(!!errors.specialty)}
                value={fields.specialty}
                onChange={setText('specialty')}
                onBlur={onBlur('specialty')}
                aria-invalid={!!errors.specialty}
              >
                <option value="">Select specialty…</option>
                <SpecialtyOptions />
              </select>
            </Field>
            <Field
              label="Practice number (PR)"
              hint="As it appears on your invoices, if you have one."
            >
              <input
                id="practice-practiceRegNumber"
                className={inputClass(false)}
                type="text"
                value={fields.practiceRegNumber}
                onChange={setText('practiceRegNumber')}
                placeholder="0123456"
              />
            </Field>
          </Section>

          {/* ── Practice address — Google Places (New) picker ──────
              Type-ahead pulls real ZA addresses from Places Autocomplete.
              On selection: addressLine1 = formatted address, lat/long
              from the place's location, suburb/city/province/postalCode
              parsed from addressComponents. addressLine2 (unit/suite)
              stays a free-text input — Places doesn't capture it. */}
          <Section title="Practice address">
            <Field label="Search for the practice address" required error={errors.addressLine1 ?? null}>
              <PlacesAutocomplete
                variant="address"
                inputId="practice-addressLine1"
                initialValue={fields.addressLine1}
                placeholder="Start typing — e.g. 1 Sandton Drive"
                onSelect={(place) => {
                  const parsed = parseAddressComponents(place.addressComponents);
                  setFields((f) => ({
                    ...f,
                    addressLine1: place.formattedAddress,
                    suburb:       parsed.suburb     ?? '',
                    city:         parsed.city       ?? '',
                    province:     parsed.province   ?? '',
                    postalCode:   parsed.postalCode ?? '',
                    latitude:     place.latitude,
                    longitude:    place.longitude,
                  }));
                }}
              />
            </Field>
            <Field label="Unit / suite">
              <input
                id="practice-addressLine2"
                className={inputClass(false)}
                type="text"
                value={fields.addressLine2}
                onChange={setText('addressLine2')}
                placeholder="Suite 4B"
              />
            </Field>
            {fields.addressLine1 && fields.latitude != null && (
              <p className="text-[11px] text-gray-500">
                Parsed: {[fields.suburb, fields.city, fields.province, fields.postalCode]
                  .filter(Boolean).join(' · ') || '—'}
              </p>
            )}
          </Section>

          {/* ── Admin account ──────────────────────────────────── */}
          <Section
            title="Your account"
            description="You'll use this email and password to sign in. Add other team members from your dashboard later."
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name" required error={errors.firstName ?? null}>
                <input
                  id="practice-firstName"
                  className={inputClass(!!errors.firstName)}
                  type="text"
                  value={fields.firstName}
                  onChange={setText('firstName')}
                  onBlur={onBlur('firstName')}
                  aria-invalid={!!errors.firstName}
                  placeholder="Jane"
                />
              </Field>
              <Field label="Last name" required error={errors.lastName ?? null}>
                <input
                  id="practice-lastName"
                  className={inputClass(!!errors.lastName)}
                  type="text"
                  value={fields.lastName}
                  onChange={setText('lastName')}
                  onBlur={onBlur('lastName')}
                  aria-invalid={!!errors.lastName}
                  placeholder="Smith"
                />
              </Field>
            </div>
            <Field
              label="Email address"
              required
              error={errors.email ?? null}
              hint={emailLocked ? 'Invited by the betternow team — email is locked to your invite.' : undefined}
            >
              <input
                id="practice-email"
                className={inputClass(!!errors.email) + (emailLocked ? ' bg-gray-50 text-gray-600 cursor-not-allowed' : '')}
                type="email"
                value={fields.email}
                onChange={setText('email')}
                onBlur={onBlur('email')}
                aria-invalid={!!errors.email}
                placeholder="jane@practice.co.za"
                readOnly={emailLocked}
              />
            </Field>
            <Field label="Password" required error={errors.password ?? null}>
              <input
                id="practice-password"
                className={inputClass(!!errors.password)}
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={fields.password}
                onChange={setText('password')}
                onBlur={onBlur('password')}
                aria-invalid={!!errors.password}
                placeholder="At least 8 characters"
              />
            </Field>
            <Field label="Confirm password" required error={errors.confirm ?? null}>
              <input
                id="practice-confirm"
                className={inputClass(!!errors.confirm)}
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={fields.confirm}
                onChange={setText('confirm')}
                onBlur={onBlur('confirm')}
                aria-invalid={!!errors.confirm}
                placeholder="Repeat password"
              />
            </Field>
            <Field
              label="Contact number"
              required
              hint="Cell or landline — we'll use this to reach you about your account."
              error={errors.phone ?? null}
            >
              <input
                id="practice-phone"
                className={inputClass(!!errors.phone)}
                type="tel"
                value={fields.phone}
                onChange={setText('phone')}
                onBlur={onBlur('phone')}
                aria-invalid={!!errors.phone}
                placeholder="082 000 0000 or 011 000 0000"
              />
            </Field>
          </Section>

          {/* ── Provider Agreement ─────────────────────────────── */}
          <div>
            <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
              errors.agreementAccepted ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-gray-50'
            }`}>
              <input
                id="practice-agreementAccepted"
                type="checkbox"
                checked={fields.agreementAccepted}
                onChange={(e) => setFields(f => ({ ...f, agreementAccepted: e.target.checked }))}
                onBlur={onBlur('agreementAccepted')}
                aria-invalid={!!errors.agreementAccepted}
                className="mt-0.5 w-4 h-4 rounded border-gray-300"
              />
              <label htmlFor="practice-agreementAccepted" className="text-sm text-gray-700 leading-relaxed">
                I agree to the{' '}
                <Link
                  href="/legal/provider-agreement"
                  target="_blank"
                  rel="noopener"
                  className="font-semibold underline underline-offset-2"
                  style={{ color: '#13294B' }}
                >
                  Provider Agreement
                </Link>
                {' '}and the{' '}
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
            {errors.agreementAccepted && (
              <p className="mt-1 text-xs text-red-600">{errors.agreementAccepted}</p>
            )}
          </div>

          {/* ── Submit-time headline ───────────────────────────── */}
          {submitError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {submitError}
            </div>
          )}

          {/* ── Submit ─────────────────────────────────────────── */}
          <button
            type="submit"
            disabled={pending.disabled}
            className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            {pending.showLabel ? 'Creating practice…' : 'Create practice'}
          </button>

          <p className="text-xs text-center text-gray-400">
            We&apos;ll review your details and approve your practice — usually within a working day. Once approved you can add doctors, banking and start sending bills.
          </p>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500">
          Already registered?{' '}
          <Link href="/login" className="font-semibold hover:underline" style={{ color: '#13294B' }}>
            Sign in →
          </Link>
        </p>
      </div>
    </div>
  );
}
