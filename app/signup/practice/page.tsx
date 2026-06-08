'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createPractice, type MemberInput } from './actions';

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

const INPUT = 'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none transition-all focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20 bg-white';
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

type StepAdmin     = { firstName: string; lastName: string; email: string; password: string; confirm: string; phone: string; saIdNumber: string };
type StepPractice  = { practiceName: string; specialty: string; hpcsaNumber: string; practiceRegNumber: string; adminEmail: string; contactPhone: string; addressLine1: string; addressLine2: string; suburb: string; city: string; province: string; postalCode: string };
type StepBanking   = { accountHolder: string; bankName: string; bankAccountNumber: string; branchCode: string; accountType: string };
type StepProviders = { adminIsProvider: boolean; adminSpecialty: string; adminHpcsaNumber: string; members: MemberInput[] };

const blankAdmin:    StepAdmin    = { firstName: '', lastName: '', email: '', password: '', confirm: '', phone: '', saIdNumber: '' };
const blankPractice: StepPractice = { practiceName: '', specialty: '', hpcsaNumber: '', practiceRegNumber: '', adminEmail: '', contactPhone: '', addressLine1: '', addressLine2: '', suburb: '', city: '', province: '', postalCode: '' };
const blankBanking:  StepBanking  = { accountHolder: '', bankName: '', bankAccountNumber: '', branchCode: '', accountType: '' };
const blankMember: () => MemberInput = () => ({ memberRole: 'provider', canCreateBills: false, canManagePractice: false, firstName: '', lastName: '', email: '', specialty: '', hpcsaNumber: '', saIdNumber: '', payoutDestination: 'practice', bankName: '', accountHolder: '', accountNumber: '', branchCode: '', accountType: '' });

// ─── Step components ──────────────────────────────────────────────────────────

function StepAdminForm({ data, onChange }: { data: StepAdmin; onChange: (d: StepAdmin) => void }) {
  const set = (key: keyof StepAdmin) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...data, [key]: e.target.value });
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[#13294B]/20 bg-[#13294B]/5 px-4 py-3">
        <p className="text-xs font-semibold text-[#13294B] mb-0.5">Your BetterNow account</p>
        <p className="text-xs text-[#13294B]/80 leading-relaxed">
          This is your personal BetterNow account — the person completing this setup. You&apos;ll have full management access to the practice. In the next step, tell us whether you&apos;re admin staff or a clinician.
        </p>
      </div>
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

function StepPracticeForm({ data, onChange }: { data: StepPractice; onChange: (d: StepPractice) => void }) {
  const set = (key: keyof StepPractice) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
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

function StepBankingForm({ data, onChange }: { data: StepBanking; onChange: (d: StepBanking) => void }) {
  const set = (key: keyof StepBanking) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const update = { ...data, [key]: e.target.value };
    if (key === 'bankName') {
      update.branchCode = BANK_BRANCH_CODES[e.target.value] ?? '';
    }
    onChange(update);
  };
  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-600 rounded-lg px-4 py-3" style={{ background: 'rgba(21,168,158,.07)', border: '1px solid rgba(21,168,158,.2)' }}>
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

function MemberCard({
  m, idx, onChange, onRemove,
}: {
  m: MemberInput;
  idx: number;
  onChange: (updated: MemberInput) => void;
  onRemove: () => void;
}) {
  const set = (key: keyof MemberInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const update = { ...m, [key]: e.target.value } as MemberInput;
    if (key === 'bankName') {
      (update as any).branchCode = BANK_BRANCH_CODES[e.target.value] ?? '';
    }
    onChange(update);
  };
  const setRole = (role: 'provider' | 'manager') => onChange({ ...m, memberRole: role });
  const setDest = (dest: 'practice' | 'provider') => onChange({ ...m, payoutDestination: dest });
  const setBool = (key: 'canCreateBills' | 'canManagePractice', val: boolean) => onChange({ ...m, [key]: val });

  return (
    <div className="border border-gray-200 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-700">Member {idx + 1}</span>
        <button type="button" onClick={onRemove} className="text-xs text-red-500 hover:text-red-700">× Remove</button>
      </div>

      {/* Role selector */}
      <div>
        <p className={LABEL}>Role</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setRole('provider')}
            className={`flex flex-col items-start rounded-xl border-2 p-4 text-left cursor-pointer transition-colors ${m.memberRole === 'provider' ? 'border-[#13294B] bg-[#13294B]/5 text-[#13294B]' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'}`}
          >
            <svg className="w-5 h-5 mb-2 shrink-0" style={{ color: '#13294B' }} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
            </svg>
            <p className="text-sm font-semibold leading-tight">Doctor / Clinician</p>
            <p className="text-xs mt-0.5 opacity-75 leading-snug">Sees patients at this practice</p>
          </button>
          <button
            type="button"
            onClick={() => setRole('manager')}
            className={`flex flex-col items-start rounded-xl border-2 p-4 text-left cursor-pointer transition-colors ${m.memberRole === 'manager' ? 'border-[#13294B] bg-[#13294B]/5 text-[#13294B]' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'}`}
          >
            <svg className="w-5 h-5 mb-2 shrink-0" style={{ color: '#13294B' }} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
            </svg>
            <p className="text-sm font-semibold leading-tight">Admin staff</p>
            <p className="text-xs mt-0.5 opacity-75 leading-snug">Admin or reception staff at this practice</p>
          </button>
        </div>
      </div>

      {/* Always shown */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name"><input className={INPUT} type="text" required value={m.firstName} onChange={set('firstName')} placeholder="John" /></Field>
        <Field label="Last name"><input className={INPUT} type="text" required value={m.lastName} onChange={set('lastName')} placeholder="Doe" /></Field>
      </div>
      <Field label="Email address"><input className={INPUT} type="email" required value={m.email} onChange={set('email')} placeholder="john@practice.co.za" /></Field>
      <Field label="SA ID number"><input className={INPUT} type="text" required maxLength={13} inputMode="numeric" value={m.saIdNumber} onChange={set('saIdNumber')} placeholder="13 digits" /></Field>

      {/* Capabilities */}
      <div className="space-y-3">
        <p className={LABEL}>Permissions</p>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-700">Can create bills</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setBool('canCreateBills', true)}
              className={`rounded-lg border px-3 py-1 text-xs font-medium transition-colors ${m.canCreateBills ? 'border-green-400 bg-green-50 text-green-700' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}`}>Yes</button>
            <button type="button" onClick={() => setBool('canCreateBills', false)}
              className={`rounded-lg border px-3 py-1 text-xs font-medium transition-colors ${!m.canCreateBills ? 'border-red-300 bg-red-50 text-red-700' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}`}>No</button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-700">Admin access</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setBool('canManagePractice', true)}
              className={`rounded-lg border px-3 py-1 text-xs font-medium transition-colors ${m.canManagePractice ? 'border-green-400 bg-green-50 text-green-700' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}`}>Yes</button>
            <button type="button" onClick={() => setBool('canManagePractice', false)}
              className={`rounded-lg border px-3 py-1 text-xs font-medium transition-colors ${!m.canManagePractice ? 'border-red-300 bg-red-50 text-red-700' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}`}>No</button>
          </div>
        </div>
      </div>

      {/* Clinical details + payout — providers only */}
      {m.memberRole === 'provider' && (
        <>
          <Field label="Specialty">
            <select className={INPUT} required value={m.specialty} onChange={set('specialty')}>
              <option value="">Select…</option>
              {SPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="HPCSA number (optional)">
            <input className={INPUT} type="text" value={m.hpcsaNumber} onChange={set('hpcsaNumber')} placeholder="Optional" />
          </Field>
          <div>
            <p className={LABEL}>Payout destination</p>
            <div className="grid grid-cols-2 gap-2">
              {(['practice', 'provider'] as const).map(dest => (
                <button
                  key={dest}
                  type="button"
                  onClick={() => setDest(dest)}
                  className={`rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors ${m.payoutDestination === dest ? 'border-[#13294B] bg-[#13294B]/5 text-[#13294B]' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}
                >
                  {dest === 'practice' ? 'Practice account' : "Provider's own account"}
                </button>
              ))}
            </div>
          </div>
          {m.payoutDestination === 'provider' && (
            <div className="space-y-4 border-t border-gray-100 pt-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Personal banking details</p>
              <Field label="Bank">
                <select className={INPUT} required value={m.bankName} onChange={set('bankName')}>
                  <option value="">Select bank…</option>
                  {BANKS.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </Field>
              <Field label="Account holder"><input className={INPUT} type="text" required value={m.accountHolder} onChange={set('accountHolder')} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Account number"><input className={INPUT} type="text" required value={m.accountNumber} onChange={set('accountNumber')} /></Field>
                <Field label="Branch code"><input className={INPUT} type="text" required value={m.branchCode} onChange={set('branchCode')} /></Field>
              </div>
              <Field label="Account type">
                <select className={INPUT} required value={m.accountType} onChange={set('accountType')}>
                  <option value="">Select…</option>
                  <option value="current">Current</option>
                  <option value="savings">Savings</option>
                </select>
              </Field>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StepProvidersForm({ data, onChange }: { data: StepProviders; onChange: (d: StepProviders) => void }) {
  const setMember    = (idx: number, updated: MemberInput) => {
    const members = data.members.map((m, i) => i === idx ? updated : m);
    onChange({ ...data, members });
  };
  const addMember    = () => onChange({ ...data, members: [...data.members, blankMember()] });
  const removeMember = (idx: number) => onChange({ ...data, members: data.members.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-6">

      {/* Section A — admin's own clinical role (independent of other providers) */}
      <div>
        <p className={LABEL}>What is your role at this practice?</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => onChange({ ...data, adminIsProvider: false })}
            className={`flex flex-col items-start rounded-xl border-2 p-4 text-left cursor-pointer transition-colors ${
              data.adminIsProvider === false
                ? 'border-[#13294B] bg-[#13294B]/5 text-[#13294B]'
                : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
            }`}
          >
            <svg className="w-5 h-5 mb-2 shrink-0" style={{ color: '#13294B' }} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
            </svg>
            <p className="text-sm font-semibold leading-tight">Admin staff</p>
            <p className="text-xs mt-0.5 opacity-75 leading-snug">I manage the practice but don&apos;t see patients</p>
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...data, adminIsProvider: true })}
            className={`flex flex-col items-start rounded-xl border-2 p-4 text-left cursor-pointer transition-colors ${
              data.adminIsProvider === true
                ? 'border-[#13294B] bg-[#13294B]/5 text-[#13294B]'
                : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
            }`}
          >
            <svg className="w-5 h-5 mb-2 shrink-0" style={{ color: '#13294B' }} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
            </svg>
            <p className="text-sm font-semibold leading-tight">Doctor / Clinician</p>
            <p className="text-xs mt-0.5 opacity-75 leading-snug">I see patients and may also manage the practice</p>
          </button>
        </div>
      </div>

      {data.adminIsProvider && (
        <div className="space-y-4 border border-gray-200 rounded-xl p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Your clinical details</p>
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

      {/* Section B — team members (always visible, always independent) */}
      <div className="space-y-4">
        <div>
          <p className={LABEL}>Add team members</p>
          <p className="mt-0.5 text-xs text-gray-400">Add doctors, specialists, managers, or admin staff. Each person will receive an email invite to set up their account.</p>
        </div>
        {data.members.map((m, idx) => (
          <MemberCard
            key={idx}
            m={m}
            idx={idx}
            onChange={updated => setMember(idx, updated)}
            onRemove={() => removeMember(idx)}
          />
        ))}
        <button
          type="button"
          onClick={addMember}
          className="w-full rounded-lg border-2 border-dashed border-gray-300 py-3 text-sm font-medium text-gray-500 hover:border-gray-400 hover:text-gray-700 transition-colors"
        >
          + Add team member
        </button>
      </div>

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

const STEPS = ['Practice details', 'Banking', 'Your account', 'Providers', 'Review'];

export default function PracticeSignupPage() {
  const [step, setStep]                     = useState(1);
  const [stepAdmin,     setStepAdmin]       = useState<StepAdmin>(blankAdmin);
  const [stepPractice,  setStepPractice]    = useState<StepPractice>(blankPractice);
  const [stepBanking,   setStepBanking]     = useState<StepBanking>(blankBanking);
  const [stepProviders, setStepProviders]   = useState<StepProviders>({ adminIsProvider: false, adminSpecialty: '', adminHpcsaNumber: '', members: [] });
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function validateStep(): string | null {
    if (step === 1) {
      if (!stepPractice.practiceName.trim()) return 'Practice name is required.';
      if (!stepPractice.specialty) return 'Specialty is required.';
      if (!stepPractice.adminEmail.trim()) return 'Practice email is required.';
      if (!stepPractice.contactPhone.trim()) return 'Contact phone is required.';
      if (!stepPractice.addressLine1.trim()) return 'Street address is required.';
      if (!stepPractice.city.trim()) return 'City is required.';
      if (!stepPractice.province) return 'Province is required.';
    }
    if (step === 2) {
      if (!stepBanking.accountHolder.trim()) return 'Account holder is required.';
      if (!stepBanking.bankName) return 'Bank is required.';
      if (!stepBanking.bankAccountNumber.trim()) return 'Account number is required.';
      if (!stepBanking.branchCode.trim()) return 'Branch code is required.';
      if (!stepBanking.accountType) return 'Account type is required.';
    }
    if (step === 3) {
      if (!stepAdmin.firstName.trim()) return 'First name is required.';
      if (!stepAdmin.lastName.trim())  return 'Last name is required.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stepAdmin.email)) return 'Enter a valid email address.';
      if (stepAdmin.password.length < 8) return 'Password must be at least 8 characters.';
      if (stepAdmin.password !== stepAdmin.confirm) return 'Passwords do not match.';
      if (!/^\d{13}$/.test(stepAdmin.saIdNumber)) return 'SA ID number must be 13 digits.';
      if (!stepAdmin.phone.trim()) return 'Phone number is required.';
    }
    if (step === 4) {
      const hasClinician = stepProviders.adminIsProvider || stepProviders.members.some(m => m.memberRole === 'provider');
      if (!hasClinician) return 'At least one doctor or clinician is required.';
      if (stepProviders.adminIsProvider && !stepProviders.adminSpecialty) return 'Please select your specialty.';
      for (const m of stepProviders.members) {
        if (!m.firstName.trim() || !m.lastName.trim()) return 'Team member name is required.';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) return 'Team member email is invalid.';
        if (!/^\d{13}$/.test(m.saIdNumber)) return 'Team member SA ID must be 13 digits.';
        if (m.memberRole === 'provider') {
          if (!m.specialty) return `Specialty is required for ${m.firstName || 'this provider'}.`;
          if (m.payoutDestination === 'provider') {
            if (!m.bankName || !m.accountHolder.trim() || !m.accountNumber.trim() || !m.branchCode.trim() || !m.accountType)
              return `Banking details required for ${m.firstName}'s personal payout.`;
          }
        }
      }
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
      ...stepAdmin,
      ...stepPractice,
      accountHolder:     stepBanking.accountHolder,
      bankName:          stepBanking.bankName,
      bankAccountNumber: stepBanking.bankAccountNumber,
      branchCode:        stepBanking.branchCode,
      accountType:       stepBanking.accountType as 'current' | 'savings',
      adminIsProvider:   stepProviders.adminIsProvider,
      adminSpecialty:    stepProviders.adminSpecialty,
      adminHpcsaNumber:  stepProviders.adminHpcsaNumber,
      members:           stepProviders.members,
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
    <div
      className="min-h-screen py-12 px-4"
      style={{
        background: '#f7fbfb',
        backgroundImage: 'radial-gradient(58% 48% at 84% 0%, rgba(21,168,158,.12), transparent 70%), radial-gradient(48% 42% at 4% 90%, rgba(19,41,75,.07), transparent 70%)',
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
                  style={active || complete ? { backgroundColor: '#13294B' } : undefined}>
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

          {step === 1 && <StepPracticeForm  data={stepPractice}  onChange={setStepPractice}  />}
          {step === 2 && <StepBankingForm   data={stepBanking}   onChange={setStepBanking}   />}
          {step === 3 && <StepAdminForm     data={stepAdmin}     onChange={setStepAdmin}     />}
          {step === 4 && <StepProvidersForm data={stepProviders} onChange={setStepProviders} />}

          {step === 5 && (
            <div className="space-y-5">
              <ReviewSection title="Practice details">
                <ReviewRow label="Name"      value={stepPractice.practiceName} />
                <ReviewRow label="Specialty" value={stepPractice.specialty} />
                <ReviewRow label="Email"     value={stepPractice.adminEmail} />
                <ReviewRow label="Phone"     value={stepPractice.contactPhone} />
                <ReviewRow label="Address"   value={[stepPractice.addressLine1, stepPractice.addressLine2, stepPractice.suburb, stepPractice.city, stepPractice.province, stepPractice.postalCode].filter(Boolean).join(', ')} />
              </ReviewSection>
              <ReviewSection title="Practice banking details">
                <ReviewRow label="Bank"           value={stepBanking.bankName} />
                <ReviewRow label="Account holder" value={stepBanking.accountHolder} />
                <ReviewRow label="Account number" value={`•••• ${stepBanking.bankAccountNumber.slice(-4)}`} />
                <ReviewRow label="Account type"   value={stepBanking.accountType} />
              </ReviewSection>
              <ReviewSection title="Practice accounts">
                <div className="space-y-5 py-3">

                  {/* PROVIDERS sub-section */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-3">Providers</p>
                    <div className="space-y-3">
                      {stepProviders.adminIsProvider && (
                        <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Provider 1 (You)</span>
                            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-[#13294B]/10 text-[#13294B]">Doctor / Clinician</span>
                          </div>
                          <p className="text-sm font-semibold text-gray-900">{stepAdmin.firstName} {stepAdmin.lastName}</p>
                          <p className="text-sm text-gray-500">{stepAdmin.email}</p>
                          {stepProviders.adminSpecialty && <p className="text-sm text-gray-600">Specialty: {stepProviders.adminSpecialty}</p>}
                          <p className="text-sm text-gray-600">Payout: Practice account</p>
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">Can create bills</span>
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">Admin access</span>
                          </div>
                        </div>
                      )}
                      {(() => {
                        let pIdx = stepProviders.adminIsProvider ? 1 : 0;
                        const providerMembers = stepProviders.members.filter(m => m.memberRole === 'provider');
                        if (!stepProviders.adminIsProvider && providerMembers.length === 0) {
                          return <p className="text-sm text-gray-400">None added</p>;
                        }
                        return providerMembers.map((m, i) => (
                          <div key={i} className="rounded-2xl border border-gray-200 bg-white p-4 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Provider {++pIdx}</span>
                              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-[#13294B]/10 text-[#13294B]">Doctor / Clinician</span>
                            </div>
                            <p className="text-sm font-semibold text-gray-900">{m.firstName} {m.lastName}</p>
                            <p className="text-sm text-gray-500">{m.email}</p>
                            {m.specialty && <p className="text-sm text-gray-600">Specialty: {m.specialty}</p>}
                            {m.hpcsaNumber && <p className="text-sm text-gray-600">HPCSA: {m.hpcsaNumber}</p>}
                            <p className="text-sm text-gray-600">
                              Payout: {m.payoutDestination === 'provider'
                                ? `Personal account${m.bankName ? ` · ${m.bankName}` : ''}`
                                : 'Practice account'}
                            </p>
                            <div className="flex flex-wrap gap-1.5 pt-1">
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${m.canCreateBills ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>Can create bills</span>
                              {m.canManagePractice && <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">Admin access</span>}
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                  </div>

                  {/* ADMIN STAFF sub-section */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-3">Admin staff</p>
                    <div className="space-y-3">
                      {!stepProviders.adminIsProvider && (
                        <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">You</span>
                            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-600">Admin staff</span>
                          </div>
                          <p className="text-sm font-semibold text-gray-900">{stepAdmin.firstName} {stepAdmin.lastName}</p>
                          <p className="text-sm text-gray-500">{stepAdmin.email}</p>
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">Can create bills</span>
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">Admin access</span>
                          </div>
                        </div>
                      )}
                      {(() => {
                        let mIdx = 0;
                        const managerMembers = stepProviders.members.filter(m => m.memberRole === 'manager');
                        if (stepProviders.adminIsProvider && managerMembers.length === 0) {
                          return <p className="text-sm text-gray-400">None added</p>;
                        }
                        return managerMembers.map((m, i) => (
                          <div key={i} className="rounded-2xl border border-gray-200 bg-white p-4 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Admin {++mIdx}</span>
                              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-600">Admin staff</span>
                            </div>
                            <p className="text-sm font-semibold text-gray-900">{m.firstName} {m.lastName}</p>
                            <p className="text-sm text-gray-500">{m.email}</p>
                            <div className="flex flex-wrap gap-1.5 pt-1">
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${m.canCreateBills ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>Can create bills</span>
                              {m.canManagePractice && <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">Admin access</span>}
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                  </div>

                </div>
              </ReviewSection>
              <p className="text-xs text-gray-400">Need to add an office manager or receptionist? You can do this from your practice dashboard after setup.</p>
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
                className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg"
                style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
              >
                Continue
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={loading}
                className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
              >
                {loading ? 'Creating practice…' : 'Create practice'}
              </button>
            )}
          </div>
        </div>

        <p className="mt-6 text-center text-sm text-gray-500">
          Already registered?{' '}
          <Link href="/login" className="font-semibold hover:underline" style={{ color: '#13294B' }}>Sign in →</Link>
        </p>
      </div>
    </div>
  );
}
