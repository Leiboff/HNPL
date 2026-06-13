'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createPractice } from './actions';
import { isValidEmail, normalizePhoneZA, checkPassword } from '@/lib/validation';

// ─── Constants ────────────────────────────────────────────────────────────────

const SPECIALTIES = [
  'General Practice', 'Dentistry', 'Physiotherapy', 'Optometry',
  'Specialist Medicine', 'Psychology', 'Nursing', 'Pharmacy', 'Other',
];

const PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal',
  'Limpopo', 'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape',
];

const INPUT =
  'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 ' +
  'placeholder-gray-400 outline-none transition-all bg-white ' +
  'focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20';
const LABEL = 'block text-sm font-medium text-gray-700 mb-1';

// ─── Field / Section helpers ─────────────────────────────────────────────────

function Field({
  label, hint, optional, children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className={LABEL}>
        {label}
        {optional && <span className="ml-1 font-normal text-gray-400">(optional)</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
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
  addressLine1:      '',
  addressLine2:      '',
  suburb:            '',
  city:              '',
  province:          '',
  postalCode:        '',

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

export default function PracticeSignupPage() {
  const [fields,  setFields]  = useState(BLANK);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function setText(key: Exclude<keyof typeof fields, 'agreementAccepted'>) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setFields(f => ({ ...f, [key]: e.target.value }));
  }

  function clientValidate(): string | null {
    if (!fields.practiceName.trim()) return 'Practice name is required.';
    if (!fields.specialty)           return 'Specialty is required.';
    if (!fields.addressLine1.trim()) return 'Street address is required.';
    if (!fields.city.trim())         return 'City is required.';
    if (!fields.province)            return 'Province is required.';

    if (!fields.firstName.trim())    return 'First name is required.';
    if (!fields.lastName.trim())     return 'Last name is required.';
    if (!isValidEmail(fields.email)) return 'Enter a valid email address.';

    if (fields.password.length < 8)  return 'Password must be at least 8 characters.';
    if (fields.password !== fields.confirm) return 'Passwords don\'t match.';
    const pwd = checkPassword(fields.password, fields.email);
    if (!pwd.ok) {
      return pwd.reason === 'contains_email_local_part'
        ? 'Please choose a password that doesn\'t contain your email address.'
        : 'That password is too common. Please choose a less guessable one.';
    }

    if (!normalizePhoneZA(fields.phone, { allowLandline: true })) {
      return 'Enter a valid South African phone number.';
    }

    if (!fields.agreementAccepted) {
      return 'Please accept the Provider Agreement to continue.';
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const err = clientValidate();
    if (err) { setError(err); return; }

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
      firstName:          fields.firstName,
      lastName:           fields.lastName,
      email:              fields.email,
      password:           fields.password,
      phone:              fields.phone,
      agreementAccepted:  fields.agreementAccepted,
    });
    setLoading(false);

    if (result.error) {
      setError(result.error);
    } else if (result.requiresManualLogin) {
      window.location.href = '/login?message=' + encodeURIComponent('Practice created — please sign in to continue.');
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

        {/* Header */}
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="inline-block text-2xl font-bold tracking-tight mb-1"
            style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-900" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
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
            <Field label="Practice name">
              <input className={INPUT} type="text" required value={fields.practiceName} onChange={setText('practiceName')} placeholder="City Medical Centre" />
            </Field>
            <Field label="Specialty">
              <select className={INPUT} required value={fields.specialty} onChange={setText('specialty')}>
                <option value="">Select specialty…</option>
                {SPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field
              label="Practice number (PR)"
              optional
              hint="As it appears on your invoices, if you have one."
            >
              <input className={INPUT} type="text" value={fields.practiceRegNumber} onChange={setText('practiceRegNumber')} placeholder="0123456" />
            </Field>
          </Section>

          {/* ── Practice address ───────────────────────────────── */}
          <Section title="Practice address">
            <Field label="Street address">
              <input className={INPUT} type="text" required value={fields.addressLine1} onChange={setText('addressLine1')} placeholder="123 Main Street" />
            </Field>
            <Field label="Address line 2" optional>
              <input className={INPUT} type="text" value={fields.addressLine2} onChange={setText('addressLine2')} placeholder="Suite 4B" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Suburb" optional>
                <input className={INPUT} type="text" value={fields.suburb} onChange={setText('suburb')} placeholder="Sandton" />
              </Field>
              <Field label="City">
                <input className={INPUT} type="text" required value={fields.city} onChange={setText('city')} placeholder="Johannesburg" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Province">
                <select className={INPUT} required value={fields.province} onChange={setText('province')}>
                  <option value="">Select…</option>
                  {PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label="Postal code" optional>
                <input className={INPUT} type="text" value={fields.postalCode} onChange={setText('postalCode')} placeholder="2196" />
              </Field>
            </div>
          </Section>

          {/* ── Admin account ──────────────────────────────────── */}
          <Section
            title="Your account"
            description="You'll use this email and password to sign in. Add other team members from your dashboard later."
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <input className={INPUT} type="text" required value={fields.firstName} onChange={setText('firstName')} placeholder="Jane" />
              </Field>
              <Field label="Last name">
                <input className={INPUT} type="text" required value={fields.lastName} onChange={setText('lastName')} placeholder="Smith" />
              </Field>
            </div>
            <Field label="Email address">
              <input className={INPUT} type="email" required value={fields.email} onChange={setText('email')} placeholder="jane@practice.co.za" />
            </Field>
            <Field label="Password">
              <input className={INPUT} type="password" required minLength={8} value={fields.password} onChange={setText('password')} placeholder="At least 8 characters" />
            </Field>
            <Field label="Confirm password">
              <input className={INPUT} type="password" required minLength={8} value={fields.confirm} onChange={setText('confirm')} placeholder="Repeat password" />
            </Field>
            <Field label="Contact number" hint="Cell or landline — we'll use this to reach you about your account.">
              <input className={INPUT} type="tel" required value={fields.phone} onChange={setText('phone')} placeholder="082 000 0000 or 011 000 0000" />
            </Field>
          </Section>

          {/* ── Provider Agreement ─────────────────────────────── */}
          <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
            <input
              id="agreement"
              type="checkbox"
              checked={fields.agreementAccepted}
              onChange={(e) => setFields(f => ({ ...f, agreementAccepted: e.target.checked }))}
              className="mt-0.5 w-4 h-4 rounded border-gray-300"
            />
            <label htmlFor="agreement" className="text-sm text-gray-700 leading-relaxed">
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
              {' '}and the BetterNow terms.
            </label>
          </div>

          {/* ── Errors ─────────────────────────────────────────── */}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* ── Submit ─────────────────────────────────────────── */}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            {loading ? 'Creating practice…' : 'Create practice'}
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
