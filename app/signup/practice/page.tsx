'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createPractice, type ProviderInput } from './actions';

// ─── Constants ────────────────────────────────────────────────────────────────

const SPECIALTIES = [
  'General Practice', 'Dentistry', 'Physiotherapy', 'Optometry',
  'Specialist Medicine', 'Psychology', 'Nursing', 'Pharmacy', 'Other',
];

const PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal',
  'Limpopo', 'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape',
];

const BANKS = [
  'ABSA', 'Capitec', 'FNB', 'Nedbank', 'Standard Bank',
  'African Bank', 'Investec', 'TymeBank', 'Discovery Bank', 'Other',
];

const BANK_BRANCH_CODES: Record<string, string> = {
  'ABSA':          '632005',
  'Capitec':       '470010',
  'FNB':           '250655',
  'Nedbank':       '198765',
  'Standard Bank': '051001',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INPUT = 'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-[#0F4C75] focus:outline-none focus:ring-1 focus:ring-[#0F4C75] bg-white';
const LABEL = 'block text-sm font-medium text-gray-700 mb-1';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={LABEL}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

// ─── State types ──────────────────────────────────────────────────────────────

type Step1 = { firstName: string; lastName: string; email: string; password: string; confirm: string; phone: string; saIdNumber: string };
type Step2 = { practiceName: string; specialty: string; hpcsaNumber: string; practiceRegNumber: string; adminEmail: string; contactPhone: string; addressLine1: string; addressLine2: string; suburb: string; city: string; province: string; postalCode: string };
type Step3 = { accountHolder: string; bankName: string; bankAccountNumber: string; branchCode: string; accountType: string };
type Step4 = { isSoleProvider: boolean; adminSpecialty: string; adminHpcsaNumber: string; providers: ProviderInput[] };

const blank1: Step1 = { firstName: '', lastName: '', email: '', password: '', confirm: '', phone: '', saIdNumber: '' };
const blank2: Step2 = { practiceName: '', specialty: '', hpcsaNumber: '', practiceRegNumber: '', adminEmail: '', contactPhone: '', addressLine1: '', addressLine2: '', suburb: '', city: '', province: '', postalCode: '' };
const blank3: Step3 = { accountHolder: '', bankName: '', bankAccountNumber: '', branchCode: '', accountType: '' };
const blankProvider: () => ProviderInput = () => ({ firstName: '', lastName: '', email: '', specialty: '', hpcsaNumber: '', saIdNumber: '', payoutDestination: 'practice', bankName: '', accountHolder: '', accountNumber: '', branchCode: '', accountType: '' });

// ─── Step components ──────────────────────────────────────────────────────────

function Step1Form({ data, onChange }: { data: Step1; onChange: (d: Step1) => void }) {
  const set = (key: keyof Step1) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...data, [key]: e.target.value });
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name"><input className={INPUT} type="text" required value={data.firstName} onChange={set('firstName')} placeholder="Jane" /></Field>
        <Field label="Last name"><input className={INPUT} type="text" required value={data.lastName} onChange={set('lastName')} placeholder="Smith" /></Field>
      </div>
      <Field label="Email address"><input className={INPUT} type="email" required value={data.email} onChange={set('email')} placeholder="jane@practice.co.za" /></Field>
      <Field label="Password"><input className={INPUT} type="password" required minLength={8} value={data.password} onChange={set('password')} placeholder="At least 8 characters" /></Field>
      <Field label="Confirm password"><input className={INPUT} type="password" required minLength={8} value={data.confirm} onChange={set('confirm')} placeholder="Repeat password" /></Field>
      <Field label="Phone number"><input className={INPUT} type="tel" required value={data.phone} onChange={set('phone')} placeholder="082 000 0000" /></Field>
      <Field label="SA ID number"><input className={INPUT} type="text" required maxLength={13} inputMode="numeric" value={data.saIdNumber} onChange={set('saIdNumber')} placeholder="13-digit ID number" /></Field>
    </div>
  );
}

function Step2Form({ data, onChange }: { data: Step2; onChange: (d: Step2) => void }) {
  const set = (key: keyof Step2) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    onChange({ ...data, [key]: e.target.value });
  return (
    <div className="space-y-5">
      <Field label="Practice name"><input className={INPUT} type="text" required value={data.practiceName} onChange={set('practiceName')} placeholder="City Medical Centre" /></Field>
      <Field label="Specialty">
        <select className={INPUT} required value={data.specialty} onChange={set('specialty')}>
          <option value="">Select specialty…</option>
          {SPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="HPCSA number" hint="Practice HPCSA registration, if applicable"><input className={INPUT} type="text" value={data.hpcsaNumber} onChange={set('hpcsaNumber')} placeholder="Optional" /></Field>
        <Field label="CIPC / reg number" hint="Company registration, if applicable"><input className={INPUT} type="text" value={data.practiceRegNumber} onChange={set('practiceRegNumber')} placeholder="Optional" /></Field>
      </div>
      <Field label="Practice email" hint="Public-facing email for patient queries"><input className={INPUT} type="email" required value={data.adminEmail} onChange={set('adminEmail')} placeholder="info@practice.co.za" /></Field>
      <Field label="Contact phone"><input className={INPUT} type="tel" required value={data.contactPhone} onChange={set('contactPhone')} placeholder="011 000 0000" /></Field>
      <Field label="Street address"><input className={INPUT} type="text" required value={data.addressLine1} onChange={set('addressLine1')} placeholder="123 Main Street" /></Field>
      <Field label="Address line 2 (optional)"><input className={INPUT} type="text" value={data.addressLine2} onChange={set('addressLine2')} placeholder="Suite 4B" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Suburb"><input className={INPUT} type="text" value={data.suburb} onChange={set('suburb')} placeholder="Sandton" /></Field>
        <Field label="City"><input className={INPUT} type="text" required value={data.city} onChange={set('city')} placeholder="Johannesburg" /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Province">
          <select className={INPUT} required value={data.province} onChange={set('province')}>
            <option value="">Select…</option>
            {PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Postal code"><input className={INPUT} type="text" value={data.postalCode} onChange={set('postalCode')} placeholder="2196" /></Field>
      </div>
    </div>
  );
}

function Step3Form({ data, onChange }: { data: Step3; onChange: (d: Step3) => void }) {
  const set = (key: keyof Step3) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const update = { ...data, [key]: e.target.value };
    if (key === 'bankName') {
      update.branchCode = BANK_BRANCH_CODES[e.target.value] ?? '';
    }
    onChange(update);
  };
  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3">
        This account will receive practice-level payouts. Individual providers can also have their own payout accounts set up below.
      </p>
      <Field label="Account holder"><input className={INPUT} type="text" required value={data.accountHolder} onChange={set('accountHolder')} placeholder="Jane Smith" /></Field>
      <Field label="Bank">
        <select className={INPUT} required value={data.bankName} onChange={set('bankName')}>
          <option value="">Select bank…</option>
          {BANKS.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
      </Field>
      <Field label="Account number"><input className={INPUT} type="text" required value={data.bankAccountNumber} onChange={set('bankAccountNumber')} placeholder="1234567890" /></Field>
      <Field label="Branch code" hint="Auto-populated for common banks — adjust if needed"><input className={INPUT} type="text" required value={data.branchCode} onChange={set('branchCode')} placeholder="632005" /></Field>
      <Field label="Account type">
        <select className={INPUT} required value={data.accountType} onChange={set('accountType')}>
          <option value="">Select…</option>
          <option value="current">Current</option>
          <option value="savings">Savings</option>
        </select>
      </Field>
    </div>
  );
}

function ProviderCard({
  p, idx, onChange, onRemove,
}: {
  p: ProviderInput;
  idx: number;
  onChange: (updated: ProviderInput) => void;
  onRemove: () => void;
}) {
  const set = (key: keyof ProviderInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const update = { ...p, [key]: e.target.value } as ProviderInput;
    if (key === 'bankName') {
      (update as any).branchCode = BANK_BRANCH_CODES[e.target.value] ?? '';
    }
    onChange(update);
  };
  const setDest = (dest: 'practice' | 'provider') => onChange({ ...p, payoutDestination: dest });

  return (
    <div className="border border-gray-200 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-700">Provider {idx + 1}</span>
        <button type="button" onClick={onRemove} className="text-xs text-red-500 hover:text-red-700">× Remove</button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name"><input className={INPUT} type="text" required value={p.firstName} onChange={set('firstName')} placeholder="John" /></Field>
        <Field label="Last name"><input className={INPUT} type="text" required value={p.lastName} onChange={set('lastName')} placeholder="Doe" /></Field>
      </div>
      <Field label="Email address"><input className={INPUT} type="email" required value={p.email} onChange={set('email')} placeholder="john@practice.co.za" /></Field>
      <Field label="Specialty">
        <select className={INPUT} required value={p.specialty} onChange={set('specialty')}>
          <option value="">Select…</option>
          {SPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="HPCSA number (optional)"><input className={INPUT} type="text" value={p.hpcsaNumber} onChange={set('hpcsaNumber')} placeholder="Optional" /></Field>
        <Field label="SA ID number"><input className={INPUT} type="text" required maxLength={13} inputMode="numeric" value={p.saIdNumber} onChange={set('saIdNumber')} placeholder="13 digits" /></Field>
      </div>

      <div>
        <p className={LABEL}>Payout destination</p>
        <div className="grid grid-cols-2 gap-2">
          {(['practice', 'provider'] as const).map(dest => (
            <button
              key={dest}
              type="button"
              onClick={() => setDest(dest)}
              className={`rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors ${p.payoutDestination === dest ? 'border-[#0F4C75] bg-[#0F4C75]/5 text-[#0F4C75]' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}
            >
              {dest === 'practice' ? 'Practice account' : "Provider's own account"}
            </button>
          ))}
        </div>
      </div>

      {p.payoutDestination === 'provider' && (
        <div className="space-y-4 border-t border-gray-100 pt-4">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Personal banking details</p>
          <Field label="Bank">
            <select className={INPUT} required value={p.bankName} onChange={set('bankName')}>
              <option value="">Select bank…</option>
              {BANKS.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </Field>
          <Field label="Account holder"><input className={INPUT} type="text" required value={p.accountHolder} onChange={set('accountHolder')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Account number"><input className={INPUT} type="text" required value={p.accountNumber} onChange={set('accountNumber')} /></Field>
            <Field label="Branch code"><input className={INPUT} type="text" required value={p.branchCode} onChange={set('branchCode')} /></Field>
          </div>
          <Field label="Account type">
            <select className={INPUT} required value={p.accountType} onChange={set('accountType')}>
              <option value="">Select…</option>
              <option value="current">Current</option>
              <option value="savings">Savings</option>
            </select>
          </Field>
        </div>
      )}
    </div>
  );
}

function Step4Form({ data, onChange }: { data: Step4; onChange: (d: Step4) => void }) {
  const setProvider = (idx: number, updated: ProviderInput) => {
    const providers = data.providers.map((p, i) => i === idx ? updated : p);
    onChange({ ...data, providers });
  };
  const addProvider = () => onChange({ ...data, providers: [...data.providers, blankProvider()] });
  const removeProvider = (idx: number) => onChange({ ...data, providers: data.providers.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-6">
      <div>
        <p className={LABEL}>Are you the sole healthcare provider at this practice?</p>
        <div className="grid grid-cols-2 gap-2">
          {[true, false].map(val => (
            <button
              key={String(val)}
              type="button"
              onClick={() => onChange({ ...data, isSoleProvider: val, providers: val ? [] : data.providers.length ? data.providers : [blankProvider()] })}
              className={`rounded-lg border-2 px-3 py-2.5 text-sm font-medium transition-colors ${data.isSoleProvider === val ? 'border-[#0F4C75] bg-[#0F4C75]/5 text-[#0F4C75]' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}
            >
              {val ? 'Yes, I\'m the only provider' : 'No, I have providers to add'}
            </button>
          ))}
        </div>
      </div>

      {data.isSoleProvider && (
        <div className="space-y-4 border border-gray-200 rounded-xl p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Your provider details</p>
          <Field label="Specialty">
            <select className={INPUT} value={data.adminSpecialty} onChange={e => onChange({ ...data, adminSpecialty: e.target.value })}>
              <option value="">Select specialty…</option>
              {SPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="HPCSA number (optional)">
            <input className={INPUT} type="text" value={data.adminHpcsaNumber} onChange={e => onChange({ ...data, adminHpcsaNumber: e.target.value })} placeholder="Optional" />
          </Field>
        </div>
      )}

      {!data.isSoleProvider && (
        <div className="space-y-4">
          {data.providers.map((p, idx) => (
            <ProviderCard
              key={idx}
              p={p}
              idx={idx}
              onChange={updated => setProvider(idx, updated)}
              onRemove={() => removeProvider(idx)}
            />
          ))}
          <button
            type="button"
            onClick={addProvider}
            className="w-full rounded-lg border-2 border-dashed border-gray-300 py-3 text-sm font-medium text-gray-500 hover:border-gray-400 hover:text-gray-700 transition-colors"
          >
            + Add another provider
          </button>
        </div>
      )}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500 shrink-0">{label}</span>
      <span className="text-sm font-medium text-gray-900 text-right">{value}</span>
    </div>
  );
}

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <div className="bg-gray-50 px-4 py-2.5 border-b border-gray-200">
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{title}</span>
      </div>
      <div className="px-4 divide-y divide-gray-100">{children}</div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const STEPS = ['Admin account', 'Practice details', 'Banking', 'Providers', 'Review'];

export default function PracticeSignupPage() {
  const [step, setStep]   = useState(1);
  const [step1, setStep1] = useState<Step1>(blank1);
  const [step2, setStep2] = useState<Step2>(blank2);
  const [step3, setStep3] = useState<Step3>(blank3);
  const [step4, setStep4] = useState<Step4>({ isSoleProvider: true, adminSpecialty: '', adminHpcsaNumber: '', providers: [] });
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function validateStep(): string | null {
    if (step === 1) {
      if (!step1.firstName.trim()) return 'First name is required.';
      if (!step1.lastName.trim())  return 'Last name is required.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(step1.email)) return 'Enter a valid email address.';
      if (step1.password.length < 8) return 'Password must be at least 8 characters.';
      if (step1.password !== step1.confirm) return 'Passwords do not match.';
      if (!/^\d{13}$/.test(step1.saIdNumber)) return 'SA ID number must be 13 digits.';
      if (!step1.phone.trim()) return 'Phone number is required.';
    }
    if (step === 2) {
      if (!step2.practiceName.trim()) return 'Practice name is required.';
      if (!step2.specialty) return 'Specialty is required.';
      if (!step2.adminEmail.trim()) return 'Practice email is required.';
      if (!step2.contactPhone.trim()) return 'Contact phone is required.';
      if (!step2.addressLine1.trim()) return 'Street address is required.';
      if (!step2.city.trim()) return 'City is required.';
      if (!step2.province) return 'Province is required.';
    }
    if (step === 3) {
      if (!step3.accountHolder.trim()) return 'Account holder is required.';
      if (!step3.bankName) return 'Bank is required.';
      if (!step3.bankAccountNumber.trim()) return 'Account number is required.';
      if (!step3.branchCode.trim()) return 'Branch code is required.';
      if (!step3.accountType) return 'Account type is required.';
    }
    if (step === 4 && !step4.isSoleProvider && step4.providers.length === 0) {
      return 'Add at least one provider, or select "I\'m the only provider".';
    }
    return null;
  }

  function handleNext() {
    const err = validateStep();
    if (err) { setError(err); return; }
    setError(null);
    setStep(s => s + 1);
  }

  async function handleSubmit() {
    setError(null);
    setLoading(true);

    const result = await createPractice({
      ...step1,
      ...step2,
      accountHolder:     step3.accountHolder,
      bankName:          step3.bankName,
      bankAccountNumber: step3.bankAccountNumber,
      branchCode:        step3.branchCode,
      accountType:       step3.accountType as 'current' | 'savings',
      isSoleProvider:    step4.isSoleProvider,
      adminSpecialty:    step4.adminSpecialty,
      adminHpcsaNumber:  step4.adminHpcsaNumber,
      providers:         step4.providers,
    });

    setLoading(false);

    if (result.error) {
      setError(result.error);
    } else if (result.requiresManualLogin) {
      window.location.href = '/login?message=' + encodeURIComponent('Practice created — please log in to continue.');
    } else {
      window.location.href = '/practice';
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="mx-auto max-w-xl">

        {/* Header */}
        <div className="mb-8 text-center">
          <Link href="/" className="text-xl font-bold" style={{ color: '#0F4C75' }}>HealthNow</Link>
          <h1 className="mt-3 text-2xl font-semibold text-gray-900">Register your practice</h1>
          <p className="mt-1 text-sm text-gray-500">Start offering interest-free payment plans in minutes.</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1 mb-8">
          {STEPS.map((label, idx) => {
            const n = idx + 1;
            const active   = step === n;
            const complete = step > n;
            return (
              <div key={n} className="flex items-center gap-1 flex-1">
                <div className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold shrink-0 transition-colors ${active ? 'text-white' : complete ? 'text-white' : 'bg-gray-200 text-gray-500'}`}
                  style={active || complete ? { backgroundColor: '#0F4C75' } : undefined}>
                  {complete ? '✓' : n}
                </div>
                <span className={`text-xs hidden sm:block truncate ${active ? 'font-semibold text-gray-900' : 'text-gray-400'}`}>{label}</span>
                {idx < STEPS.length - 1 && <div className="flex-1 h-px bg-gray-200 mx-1" />}
              </div>
            );
          })}
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          <h2 className="text-base font-semibold text-gray-900 mb-6">
            Step {step}: {STEPS[step - 1]}
          </h2>

          {step === 1 && <Step1Form data={step1} onChange={setStep1} />}
          {step === 2 && <Step2Form data={step2} onChange={setStep2} />}
          {step === 3 && <Step3Form data={step3} onChange={setStep3} />}
          {step === 4 && <Step4Form data={step4} onChange={setStep4} />}

          {step === 5 && (
            <div className="space-y-5">
              <ReviewSection title="Admin account">
                <ReviewRow label="Name"  value={`${step1.firstName} ${step1.lastName}`} />
                <ReviewRow label="Email" value={step1.email} />
                <ReviewRow label="Phone" value={step1.phone} />
              </ReviewSection>
              <ReviewSection title="Practice details">
                <ReviewRow label="Name"      value={step2.practiceName} />
                <ReviewRow label="Specialty" value={step2.specialty} />
                <ReviewRow label="Email"     value={step2.adminEmail} />
                <ReviewRow label="Phone"     value={step2.contactPhone} />
                <ReviewRow label="Address"   value={[step2.addressLine1, step2.addressLine2, step2.suburb, step2.city, step2.province, step2.postalCode].filter(Boolean).join(', ')} />
              </ReviewSection>
              <ReviewSection title="Banking">
                <ReviewRow label="Bank"           value={step3.bankName} />
                <ReviewRow label="Account holder" value={step3.accountHolder} />
                <ReviewRow label="Account number" value={`•••• ${step3.bankAccountNumber.slice(-4)}`} />
                <ReviewRow label="Account type"   value={step3.accountType} />
              </ReviewSection>
              <ReviewSection title="Providers">
                {step4.isSoleProvider ? (
                  <ReviewRow label="Setup" value="Sole provider (admin)" />
                ) : (
                  step4.providers.map((p, i) => (
                    <ReviewRow
                      key={i}
                      label={`Provider ${i + 1}`}
                      value={`${p.firstName} ${p.lastName} — ${p.specialty} — Pays to: ${p.payoutDestination === 'practice' ? 'practice' : 'personal account'}`}
                    />
                  ))
                )}
              </ReviewSection>
            </div>
          )}

          {error && (
            <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mt-8 flex gap-3">
            {step > 1 && (
              <button
                type="button"
                onClick={() => { setError(null); setStep(s => s - 1); }}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Back
              </button>
            )}
            {step < 5 ? (
              <button
                type="button"
                onClick={handleNext}
                className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors"
                style={{ backgroundColor: '#0F4C75' }}
              >
                Continue
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={loading}
                className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                style={{ backgroundColor: '#0F4C75' }}
              >
                {loading ? 'Creating practice…' : 'Create practice'}
              </button>
            )}
          </div>
        </div>

        <p className="mt-6 text-center text-sm text-gray-500">
          Already registered?{' '}
          <Link href="/login" className="font-medium" style={{ color: '#0F4C75' }}>Sign in →</Link>
        </p>
      </div>
    </div>
  );
}
