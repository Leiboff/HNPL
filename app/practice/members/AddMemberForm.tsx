'use client';

import { useState } from 'react';
import type { NewMemberInput } from './actions';

// ─── Shared "Add team member" form ────────────────────────────────────
//
// One component, two surfaces:
//   • practice-admin (/practice/members) — SA ID required, full payout
//     destination + personal-banking sub-form.
//   • brand-admin  (/brand/branch/[id])  — SA ID optional (completed
//     at /provider/setup), payout + banking sub-form hidden (also
//     completed at /provider/setup).
//
// Same specialty dropdown, same role picker options, same YesNoToggle,
// same submit shape (NewMemberInput). The caller wires onSubmit to
// whichever server action guards + delegates to
// inviteMemberIntoPractice under the hood.
//
// Extracted from MembersView so the two surfaces stay in lockstep. If
// you add a specialty or a payout field here, both surfaces get it.

// Kept in this module (rather than a separate constants file) because
// they define the semantic surface of the form; a change here is a
// change to both surfaces at once, which is exactly what we want.
export const SPECIALTIES = [
  'General Practice', 'Dentistry', 'Physiotherapy', 'Optometry',
  'Specialist Medicine', 'Psychology', 'Nursing', 'Pharmacy', 'Other',
] as const;

export const BANKS = [
  'ABSA', 'Capitec', 'FNB', 'Nedbank', 'Standard Bank',
  'African Bank', 'Investec', 'TymeBank', 'Discovery Bank', 'Other',
] as const;

type AddDraft = {
  memberRole:             'provider' | 'manager';
  firstName:              string;
  lastName:               string;
  email:                  string;
  saIdNumber:             string;
  canCreateBills:         boolean;
  canManagePractice:      boolean;
  specialty:              string;
  hpcsaNumber:            string;
  payoutDestination:      'practice' | 'provider';
  personalBankName:       string;
  personalAccountHolder:  string;
  personalAccountNumber:  string;
  personalBranchCode:     string;
  personalAccountType:    string;
};

const BLANK: AddDraft = {
  memberRole:             'provider',
  firstName:              '',
  lastName:               '',
  email:                  '',
  saIdNumber:             '',
  canCreateBills:         false,
  canManagePractice:      false,
  specialty:              '',
  hpcsaNumber:            '',
  payoutDestination:      'practice',
  personalBankName:       '',
  personalAccountHolder:  '',
  personalAccountNumber:  '',
  personalBranchCode:     '',
  personalAccountType:    '',
};

const INPUT_CLS =
  'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-[#15A89E]/30 focus:border-[#15A89E] transition-colors';
const SELECT_CLS = INPUT_CLS;

type Props = {
  /** true → SA ID required client-side + input shown; false → hidden (deferred to /provider/setup) */
  saIdRequired:      boolean;
  /** true → shows payout destination + personal banking sub-form (practice-admin path). */
  showPayoutFields:  boolean;
  onSubmit:          (input: NewMemberInput) => Promise<{ error: string | null }>;
  onCancel:          () => void;
  submitLabel?:      string;
  successMessage?:   (email: string) => string;
};

export default function AddMemberForm({
  saIdRequired,
  showPayoutFields,
  onSubmit,
  onCancel,
  submitLabel = 'Invite & add to practice',
}: Props) {
  const [draft,   setDraft]   = useState<AddDraft>(BLANK);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isProvider = draft.memberRole === 'provider';

  function patch(p: Partial<AddDraft>) {
    setDraft((d) => ({ ...d, ...p }));
  }

  async function handleSubmit() {
    setLoading(true);
    setError(null);

    if (saIdRequired && !draft.saIdNumber.trim()) {
      setLoading(false);
      setError('SA ID number is required.');
      return;
    }

    const input: NewMemberInput = {
      memberRole:             draft.memberRole,
      firstName:              draft.firstName,
      lastName:               draft.lastName,
      email:                  draft.email,
      saIdNumber:             draft.saIdNumber,
      canCreateBills:         draft.canCreateBills,
      canManagePractice:      draft.canManagePractice,
      specialty:              draft.specialty              || undefined,
      hpcsaNumber:            draft.hpcsaNumber            || undefined,
      payoutDestination:      draft.payoutDestination,
      personalBankName:       draft.personalBankName       || undefined,
      personalAccountHolder:  draft.personalAccountHolder  || undefined,
      personalAccountNumber:  draft.personalAccountNumber  || undefined,
      personalBranchCode:     draft.personalBranchCode     || undefined,
      personalAccountType:    draft.personalAccountType    || undefined,
    };

    const result = await onSubmit(input);
    setLoading(false);
    if (result.error) setError(result.error);
    else setDraft(BLANK);
  }

  return (
    <div
      className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-6 mb-6"
      data-testid="add-member-form"
    >

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-gray-900">Add team member</h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          × Cancel
        </button>
      </div>

      {/* Role selector */}
      <div>
        <SectionLabel>Role</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          {([
            { value: 'provider' as const, label: 'Doctor / Practitioner', sub: 'Sees patients, has clinical details' },
            { value: 'manager' as const,  label: 'Admin staff',           sub: 'Manages billing and/or the practice' },
          ]).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => patch({ memberRole: opt.value })}
              data-testid={`add-member-role-${opt.value}`}
              className={`rounded-xl border p-4 text-left transition-colors ${
                draft.memberRole === opt.value
                  ? 'border-[#13294B] bg-[#13294B]/5'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <p className={`text-sm font-semibold ${draft.memberRole === opt.value ? 'text-[#13294B]' : 'text-gray-800'}`}>{opt.label}</p>
              <p className="text-xs text-gray-400 mt-0.5">{opt.sub}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Personal details */}
      <div className="space-y-3">
        <SectionLabel>Personal details</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="First name">
            <input
              type="text"
              value={draft.firstName}
              onChange={(e) => patch({ firstName: e.target.value })}
              className={INPUT_CLS}
              data-testid="add-member-firstname"
            />
          </FormField>
          <FormField label="Last name">
            <input
              type="text"
              value={draft.lastName}
              onChange={(e) => patch({ lastName: e.target.value })}
              className={INPUT_CLS}
              data-testid="add-member-lastname"
            />
          </FormField>
        </div>
        <FormField label="Email address">
          <input
            type="email"
            value={draft.email}
            onChange={(e) => patch({ email: e.target.value })}
            className={INPUT_CLS}
            placeholder="they@example.com"
            data-testid="add-member-email"
          />
        </FormField>
        {saIdRequired && (
          <FormField label="SA ID number">
            <input
              type="text"
              value={draft.saIdNumber}
              onChange={(e) => patch({ saIdNumber: e.target.value })}
              className={INPUT_CLS}
              placeholder="13-digit ID number"
              maxLength={13}
              data-testid="add-member-saId"
            />
          </FormField>
        )}
        {!saIdRequired && (
          <p className="text-xs text-gray-400">
            The new member enters their SA ID, banking, and password on <span className="font-mono">/provider/setup</span> after they accept the invite.
          </p>
        )}
      </div>

      {/* Permissions */}
      <div className="space-y-3">
        <SectionLabel>Permissions</SectionLabel>
        <FieldRow label="Can create bills">
          <YesNoToggle value={draft.canCreateBills} onChange={(v) => patch({ canCreateBills: v })} testid="add-member-canCreateBills" />
        </FieldRow>
        <FieldRow label="Admin access">
          <YesNoToggle value={draft.canManagePractice} onChange={(v) => patch({ canManagePractice: v })} testid="add-member-canManage" />
        </FieldRow>
      </div>

      {/* Provider-only: clinical (+ payout on practice-admin surface) */}
      {isProvider && (
        <div className="space-y-3 pt-2 border-t border-gray-100">
          <SectionLabel>Clinical details</SectionLabel>
          <FormField label="Specialty">
            <select
              value={draft.specialty}
              onChange={(e) => patch({ specialty: e.target.value })}
              className={SELECT_CLS}
              data-testid="add-member-specialty"
            >
              <option value="">Select specialty</option>
              {SPECIALTIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </FormField>
          <FormField label="HPCSA number (optional)">
            <input
              type="text"
              value={draft.hpcsaNumber}
              onChange={(e) => patch({ hpcsaNumber: e.target.value })}
              className={INPUT_CLS}
              placeholder="e.g. MP0123456"
              data-testid="add-member-hpcsa"
            />
          </FormField>
        </div>
      )}

      {isProvider && showPayoutFields && (
        <div className="space-y-3 pt-2 border-t border-gray-100">
          <SectionLabel>Payout destination</SectionLabel>
          <div className="flex gap-3">
            {(['practice', 'provider'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => patch({ payoutDestination: opt })}
                className={`flex-1 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
                  draft.payoutDestination === opt
                    ? 'border-[#13294B] bg-[#13294B]/5 text-[#13294B]'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                {opt === 'practice' ? 'Practice account' : "Provider's own account"}
              </button>
            ))}
          </div>

          {draft.payoutDestination === 'provider' && (
            <div className="space-y-3 pt-1">
              <SectionLabel>Personal banking details</SectionLabel>
              <FormField label="Bank">
                <select
                  value={draft.personalBankName}
                  onChange={(e) => patch({ personalBankName: e.target.value })}
                  className={SELECT_CLS}
                >
                  <option value="">Select bank</option>
                  {BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </FormField>
              <FormField label="Account holder">
                <input type="text" value={draft.personalAccountHolder} onChange={(e) => patch({ personalAccountHolder: e.target.value })} className={INPUT_CLS} />
              </FormField>
              <FormField label="Account number">
                <input type="text" value={draft.personalAccountNumber} onChange={(e) => patch({ personalAccountNumber: e.target.value })} className={INPUT_CLS} />
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Branch code">
                  <input type="text" value={draft.personalBranchCode} onChange={(e) => patch({ personalBranchCode: e.target.value })} className={INPUT_CLS} />
                </FormField>
                <FormField label="Account type">
                  <select value={draft.personalAccountType} onChange={(e) => patch({ personalAccountType: e.target.value })} className={SELECT_CLS}>
                    <option value="">Select</option>
                    <option value="current">Current</option>
                    <option value="savings">Savings</option>
                  </select>
                </FormField>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={loading}
        data-testid="add-member-submit"
        className="w-full py-2.5 text-white text-sm font-semibold rounded-xl disabled:opacity-50 transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
      >
        {loading ? 'Sending invitation…' : submitLabel}
      </button>
    </div>
  );
}

// ─── Local primitives ─────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">{children}</p>;
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-gray-700 shrink-0">{label}</span>
      {children}
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-gray-500">{label}</label>
      {children}
    </div>
  );
}

function YesNoToggle({
  value, onChange, disabled, testid,
}: {
  value: boolean; onChange: (v: boolean) => void; disabled?: boolean; testid?: string;
}) {
  return (
    <div
      className={`flex rounded-full border overflow-hidden text-xs select-none ${disabled ? 'opacity-50 pointer-events-none' : 'border-gray-200'}`}
      data-testid={testid}
    >
      <button
        type="button"
        onClick={() => onChange(true)}
        className={`px-3 py-1.5 transition-colors ${value ? 'bg-green-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
      >
        Yes
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        className={`px-3 py-1.5 transition-colors ${!value ? 'bg-red-500 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
      >
        No
      </button>
    </div>
  );
}
