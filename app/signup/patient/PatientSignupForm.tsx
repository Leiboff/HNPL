'use client';

import { useState } from 'react';
import Link from 'next/link';
import { signUpPatient } from './actions';
import SalaryDayPicker from '@/components/SalaryDayPicker';

type Invitation = {
  email:        string;
  practiceName: string | null;
};

type Props = {
  invitation?: Invitation | null;
  token?:      string | null;
};

const INPUT_CLS = 'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none transition-all focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20';
const LABEL_CLS = 'block text-sm font-medium text-gray-700 mb-1';

export default function PatientSignupForm({ invitation, token }: Props) {
  const [fields, setFields] = useState({
    firstName:  '',
    lastName:   '',
    email:      invitation?.email ?? '',
    password:   '',
    confirm:    '',
    phone:      '',
    saIdNumber: '',
    salaryDay:  '',
  });
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done,    setDone]    = useState(false);

  function set(key: keyof typeof fields) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setFields(f => ({ ...f, [key]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (fields.password !== fields.confirm) {
      setError('Passwords do not match.');
      return;
    }

    if (!fields.salaryDay) {
      // Picker has no native required attribute — block submit on empty.
      setError('Please choose when your salary is paid.');
      return;
    }

    setLoading(true);
    const result = await signUpPatient({
      firstName:  fields.firstName.trim(),
      lastName:   fields.lastName.trim(),
      email:      fields.email.trim(),
      password:   fields.password,
      phone:      fields.phone.trim(),
      saIdNumber: fields.saIdNumber.trim(),
      salaryDay:  parseInt(fields.salaryDay, 10),
      token:      token ?? undefined,
    });
    setLoading(false);

    if (result.error) setError(result.error);
    else setDone(true);
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-green-200 bg-green-50 p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-green-900">Check your email</h2>
        <p className="mt-2 text-sm text-green-800 max-w-sm mx-auto">
          We&apos;ve sent you a confirmation link. Click it to activate your account and start using BetterNow.
        </p>
      </div>
    );
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

      {error && (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL_CLS}>First name</label>
            <input type="text" required value={fields.firstName} onChange={set('firstName')} placeholder="Jane" className={INPUT_CLS} />
          </div>
          <div>
            <label className={LABEL_CLS}>Last name</label>
            <input type="text" required value={fields.lastName} onChange={set('lastName')} placeholder="Smith" className={INPUT_CLS} />
          </div>
        </div>

        <div>
          <label className={LABEL_CLS}>Email address</label>
          <input
            type="email"
            required
            value={fields.email}
            onChange={invitation ? undefined : set('email')}
            readOnly={!!invitation}
            placeholder="jane@example.com"
            className={`${INPUT_CLS} ${invitation ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : ''}`}
          />
        </div>

        <div>
          <label className={LABEL_CLS}>Password</label>
          <input type="password" required minLength={8} value={fields.password} onChange={set('password')} placeholder="At least 8 characters" className={INPUT_CLS} />
        </div>

        <div>
          <label className={LABEL_CLS}>Confirm password</label>
          <input type="password" required minLength={8} value={fields.confirm} onChange={set('confirm')} placeholder="Repeat your password" className={INPUT_CLS} />
        </div>

        <div>
          <label className={LABEL_CLS}>Cell number</label>
          <input type="tel" required value={fields.phone} onChange={set('phone')} placeholder="082 000 0000" className={INPUT_CLS} />
        </div>

        <div>
          <label className={LABEL_CLS}>SA ID number</label>
          <input type="text" required maxLength={13} inputMode="numeric" value={fields.saIdNumber} onChange={set('saIdNumber')} placeholder="13-digit ID number" className={INPUT_CLS} />
        </div>

        <div>
          <SalaryDayPicker
            value={fields.salaryDay === '' ? null : parseInt(fields.salaryDay, 10)}
            onChange={(d) => setFields(f => ({ ...f, salaryDay: String(d) }))}
          />
        </div>

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
