'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  updateMember, disableMember, enableMember, addMember,
  type MemberUpdates, type NewMemberInput,
} from './actions';
import SelfAsProviderCard from './SelfAsProviderCard';

// ─── Types ────────────────────────────────────────────────────────────────────

type MemberProfile = { first_name: string; last_name: string; email: string };

export type MemberRow = {
  id:                      string;
  user_id:                 string;
  role:                    'admin' | 'provider';
  active:                  boolean;
  can_create_bills:        boolean;
  can_manage_practice:     boolean;
  specialty:               string | null;
  hpcsa_number:            string | null;
  payout_destination:      'practice' | 'provider' | null;
  personal_bank_name:      string | null;
  personal_account_holder: string | null;
  personal_account_number: string | null;
  personal_branch_code:    string | null;
  personal_account_type:   string | null;
  profile:                 MemberProfile | MemberProfile[] | null;
};

type EditDraft = {
  can_create_bills:        boolean;
  can_manage_practice:     boolean;
  specialty:               string;
  hpcsa_number:            string;
  payout_destination:      'practice' | 'provider';
  personal_bank_name:      string;
  personal_account_holder: string;
  personal_account_number: string;
  personal_branch_code:    string;
  personal_account_type:   string;
};

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

type Props = {
  members:       MemberRow[];
  currentUserId: string;
  isManager:     boolean;
  practiceName:  string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const SPECIALTIES = [
  'General Practice', 'Dentistry', 'Physiotherapy', 'Optometry',
  'Specialist Medicine', 'Psychology', 'Nursing', 'Pharmacy', 'Other',
];

const BANKS = [
  'ABSA', 'Capitec', 'FNB', 'Nedbank', 'Standard Bank',
  'African Bank', 'Investec', 'TymeBank', 'Discovery Bank', 'Other',
];

const BLANK_ADD: AddDraft = {
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

// ─── Primitive UI helpers ─────────────────────────────────────────────────────

const INPUT_CLS = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#15A89E]/30 focus:border-[#15A89E] transition-colors';
const SELECT_CLS = INPUT_CLS;

function RolePill({ role }: { role: 'admin' | 'provider' }) {
  return role === 'provider'
    ? <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-[#13294B] text-white">Doctor / Clinician</span>
    : <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-600">Admin staff</span>;
}

function CapBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
      active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
    }`}>
      {label}
    </span>
  );
}

function YesNoToggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className={`flex rounded-full border overflow-hidden text-xs select-none ${disabled ? 'opacity-50 pointer-events-none' : 'border-gray-200'}`}>
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">{children}</p>
  );
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

// ─── Helper functions ─────────────────────────────────────────────────────────

function getProfile(m: MemberRow): MemberProfile {
  const p = Array.isArray(m.profile) ? m.profile[0] : m.profile;
  return p ?? { first_name: 'Unknown', last_name: 'User', email: '—' };
}

function displayName(m: MemberRow): string {
  const p = getProfile(m);
  return `${p.first_name} ${p.last_name}`;
}

function countManagers(members: MemberRow[], excludeId?: string): number {
  return members.filter(m => m.active && m.can_manage_practice && m.id !== excludeId).length;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MembersView({ members: initialMembers, currentUserId, isManager }: Props) {
  const router = useRouter();

  const [members,      setMembers]      = useState<MemberRow[]>(initialMembers);
  const [editingId,    setEditingId]    = useState<string | null>(null);
  const [editDraft,    setEditDraft]    = useState<EditDraft | null>(null);
  const [editError,    setEditError]    = useState<string | null>(null);
  const [editLoading,  setEditLoading]  = useState(false);

  const [showAdd,      setShowAdd]      = useState(false);
  const [addDraft,     setAddDraft]     = useState<AddDraft>(BLANK_ADD);
  const [addError,     setAddError]     = useState<string | null>(null);
  const [addLoading,   setAddLoading]   = useState(false);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [actionLoading,setActionLoading]= useState(false);

  const [flashMsg,     setFlashMsg]     = useState<string | null>(null);
  const [flashError,   setFlashError]   = useState<string | null>(null);

  // ── Derived lists ──────────────────────────────────────────────────────────
  const activeProviders = members.filter(m => m.active && m.role === 'provider');
  const activeAdmins    = members.filter(m => m.active && m.role === 'admin');
  const disabledMembers = members.filter(m => !m.active);
  const meAsMember      = members.find(m => m.user_id === currentUserId);
  const otherAdmins     = activeAdmins.filter(m => m.user_id !== currentUserId);

  // ── Flash helpers ──────────────────────────────────────────────────────────
  function flash(msg: string) {
    setFlashMsg(msg);
    setFlashError(null);
    setTimeout(() => setFlashMsg(null), 4000);
  }

  function flashErr(msg: string) {
    setFlashError(msg);
    setFlashMsg(null);
    setTimeout(() => setFlashError(null), 6000);
  }

  // ── Edit handlers ──────────────────────────────────────────────────────────
  function openEdit(m: MemberRow) {
    setEditingId(m.id);
    setEditDraft({
      can_create_bills:        m.can_create_bills,
      can_manage_practice:     m.can_manage_practice,
      specialty:               m.specialty               ?? '',
      hpcsa_number:            m.hpcsa_number            ?? '',
      payout_destination:      m.payout_destination      ?? 'practice',
      personal_bank_name:      m.personal_bank_name      ?? '',
      personal_account_holder: m.personal_account_holder ?? '',
      personal_account_number: m.personal_account_number ?? '',
      personal_branch_code:    m.personal_branch_code    ?? '',
      personal_account_type:   m.personal_account_type   ?? '',
    });
    setEditError(null);
    setConfirmingId(null);
  }

  function closeEdit() {
    setEditingId(null);
    setEditDraft(null);
    setEditError(null);
  }

  function patchDraft(patch: Partial<EditDraft>) {
    setEditDraft(prev => prev ? { ...prev, ...patch } : prev);
  }

  async function handleSaveEdit(m: MemberRow) {
    if (!editDraft) return;
    setEditLoading(true);
    setEditError(null);

    const updates: MemberUpdates = {
      can_create_bills:    editDraft.can_create_bills,
      can_manage_practice: editDraft.can_manage_practice,
    };

    if (m.role === 'provider') {
      updates.specialty          = editDraft.specialty     || null;
      updates.hpcsa_number       = editDraft.hpcsa_number  || null;
      updates.payout_destination = editDraft.payout_destination;
      if (editDraft.payout_destination === 'provider') {
        updates.personal_bank_name      = editDraft.personal_bank_name      || null;
        updates.personal_account_holder = editDraft.personal_account_holder || null;
        updates.personal_account_number = editDraft.personal_account_number || null;
        updates.personal_branch_code    = editDraft.personal_branch_code    || null;
        updates.personal_account_type   = editDraft.personal_account_type   || null;
      } else {
        updates.personal_bank_name      = null;
        updates.personal_account_holder = null;
        updates.personal_account_number = null;
        updates.personal_branch_code    = null;
        updates.personal_account_type   = null;
      }
    }

    const result = await updateMember(m.id, updates);
    setEditLoading(false);

    if (result.error) {
      setEditError(result.error);
    } else {
      setMembers(prev => prev.map(row => row.id === m.id ? {
        ...row,
        can_create_bills:        updates.can_create_bills    ?? row.can_create_bills,
        can_manage_practice:     updates.can_manage_practice ?? row.can_manage_practice,
        specialty:               'specialty'               in updates ? updates.specialty               ?? null : row.specialty,
        hpcsa_number:            'hpcsa_number'            in updates ? updates.hpcsa_number            ?? null : row.hpcsa_number,
        payout_destination:      'payout_destination'      in updates ? updates.payout_destination      ?? null : row.payout_destination,
        personal_bank_name:      'personal_bank_name'      in updates ? updates.personal_bank_name      ?? null : row.personal_bank_name,
        personal_account_holder: 'personal_account_holder' in updates ? updates.personal_account_holder ?? null : row.personal_account_holder,
        personal_account_number: 'personal_account_number' in updates ? updates.personal_account_number ?? null : row.personal_account_number,
        personal_branch_code:    'personal_branch_code'    in updates ? updates.personal_branch_code    ?? null : row.personal_branch_code,
        personal_account_type:   'personal_account_type'   in updates ? updates.personal_account_type   ?? null : row.personal_account_type,
      } : row));
      closeEdit();
      flash('Changes saved.');
    }
  }

  // ── Disable / enable handlers ──────────────────────────────────────────────
  async function handleDisable(memberId: string) {
    setActionLoading(true);
    const result = await disableMember(memberId);
    setActionLoading(false);
    setConfirmingId(null);
    if (result.error) {
      flashErr(result.error);
    } else {
      setMembers(prev => prev.map(m => m.id === memberId ? { ...m, active: false } : m));
      flash('Member disabled.');
    }
  }

  async function handleEnable(memberId: string) {
    setActionLoading(true);
    const result = await enableMember(memberId);
    setActionLoading(false);
    if (result.error) {
      flashErr(result.error);
    } else {
      setMembers(prev => prev.map(m => m.id === memberId ? { ...m, active: true } : m));
      flash('Member re-enabled.');
    }
  }

  // ── Add member handler ─────────────────────────────────────────────────────
  async function handleAddMember() {
    setAddLoading(true);
    setAddError(null);
    const input: NewMemberInput = {
      memberRole:             addDraft.memberRole,
      firstName:              addDraft.firstName,
      lastName:               addDraft.lastName,
      email:                  addDraft.email,
      saIdNumber:             addDraft.saIdNumber,
      canCreateBills:         addDraft.canCreateBills,
      canManagePractice:      addDraft.canManagePractice,
      specialty:              addDraft.specialty              || undefined,
      hpcsaNumber:            addDraft.hpcsaNumber            || undefined,
      payoutDestination:      addDraft.payoutDestination,
      personalBankName:       addDraft.personalBankName       || undefined,
      personalAccountHolder:  addDraft.personalAccountHolder  || undefined,
      personalAccountNumber:  addDraft.personalAccountNumber  || undefined,
      personalBranchCode:     addDraft.personalBranchCode     || undefined,
      personalAccountType:    addDraft.personalAccountType    || undefined,
    };
    const result = await addMember(input);
    setAddLoading(false);
    if (result.error) {
      setAddError(result.error);
    } else {
      setShowAdd(false);
      setAddDraft(BLANK_ADD);
      flash(`Invitation sent to ${addDraft.email}. The new member will appear below once processed.`);
      router.refresh();
    }
  }

  // ── Card sub-render ────────────────────────────────────────────────────────
  function renderCard(m: MemberRow, opts: { isMe?: boolean } = {}) {
    const profile        = getProfile(m);
    const name           = displayName(m);
    const isEditing      = editingId === m.id;
    const isConfirming   = confirmingId === m.id;
    const isLastManager  = m.can_manage_practice && countManagers(members, m.id) === 0;
    const canDisable     = isManager && !opts.isMe && !isLastManager;
    const payout         = m.payout_destination ?? 'practice';

    return (
      <div key={m.id} className="space-y-3">

        {/* Card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">

          {/* Top row */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-gray-900">{name}</p>
                {opts.isMe && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[#15A89E] bg-[#15A89E]/10 rounded-full px-2 py-0.5">
                    You
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-500 mt-0.5 truncate">{profile.email}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <RolePill role={m.role} />
              {isManager && (
                <button
                  onClick={() => isEditing ? closeEdit() : openEdit(m)}
                  className="text-xs font-medium text-[#15A89E] hover:text-[#13294B] transition-colors px-2 py-1 rounded-lg hover:bg-[#15A89E]/10"
                >
                  {isEditing ? 'Cancel' : 'Edit'}
                </button>
              )}
              {canDisable && !isEditing && (
                <button
                  onClick={() => setConfirmingId(m.id)}
                  className="text-xs font-medium text-red-500 hover:text-red-700 transition-colors px-2 py-1 rounded-lg hover:bg-red-50"
                  title={isLastManager ? 'Last practice manager — cannot disable' : undefined}
                >
                  Disable
                </button>
              )}
              {isManager && !opts.isMe && isLastManager && !isEditing && (
                <span className="text-[10px] text-gray-400 italic">Last manager</span>
              )}
            </div>
          </div>

          {/* Details */}
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 items-center">
            {m.role === 'provider' && m.specialty && (
              <span className="text-sm text-gray-600">
                {m.specialty}{m.hpcsa_number ? ` · ${m.hpcsa_number}` : ''}
              </span>
            )}
            <div className="flex gap-2 flex-wrap">
              <CapBadge label="Can create bills" active={m.can_create_bills} />
              {m.can_manage_practice && <CapBadge label="Admin access" active={true} />}
            </div>
            {m.role === 'provider' && (
              <span className="text-xs text-gray-400">
                Payout: {payout === 'provider'
                  ? `Personal account${m.personal_bank_name ? ` · ${m.personal_bank_name}` : ''}`
                  : 'Practice account'}
              </span>
            )}
          </div>

          {/* Disable confirmation */}
          {isConfirming && (
            <div className="mt-4 p-3 bg-red-50 rounded-xl border border-red-200">
              <p className="text-sm text-red-700 font-medium">
                Disable {name}?
              </p>
              <p className="text-xs text-red-600 mt-0.5">
                They will lose access immediately. Their data is preserved and they can be re-enabled later.
              </p>
              <div className="flex items-center gap-2 mt-3">
                <button
                  onClick={() => handleDisable(m.id)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 disabled:opacity-60 transition-colors"
                >
                  {actionLoading ? 'Disabling…' : 'Yes, disable'}
                </button>
                <button
                  onClick={() => setConfirmingId(null)}
                  className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Edit panel */}
        {isEditing && editDraft && renderEditPanel(m)}
      </div>
    );
  }

  // ── Edit panel ─────────────────────────────────────────────────────────────
  function renderEditPanel(m: MemberRow) {
    if (!editDraft) return null;
    const isProvider = m.role === 'provider';
    const wouldLoseLastManager =
      editDraft.can_manage_practice === false &&
      m.can_manage_practice &&
      countManagers(members, m.id) === 0;

    return (
      <div className="bg-gray-50 rounded-2xl border border-gray-200 p-5 space-y-5">

        {/* Permissions */}
        <div className="space-y-3">
          <SectionLabel>Permissions</SectionLabel>
          <FieldRow label="Can create bills">
            <YesNoToggle
              value={editDraft.can_create_bills}
              onChange={v => patchDraft({ can_create_bills: v })}
            />
          </FieldRow>
          <FieldRow label="Admin access">
            <YesNoToggle
              value={editDraft.can_manage_practice}
              onChange={v => patchDraft({ can_manage_practice: v })}
              disabled={wouldLoseLastManager && !editDraft.can_manage_practice}
            />
          </FieldRow>
          {wouldLoseLastManager && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              This is the last manager. You must grant admin access to another member before removing it here.
            </p>
          )}
        </div>

        {/* Provider-only fields */}
        {isProvider && (
          <div className="space-y-3 pt-4 border-t border-gray-200">
            <SectionLabel>Clinical details</SectionLabel>

            <FormField label="Specialty">
              <select
                value={editDraft.specialty}
                onChange={e => patchDraft({ specialty: e.target.value })}
                className={SELECT_CLS}
              >
                <option value="">Select specialty</option>
                {SPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormField>

            <FormField label="HPCSA number (optional)">
              <input
                type="text"
                value={editDraft.hpcsa_number}
                onChange={e => patchDraft({ hpcsa_number: e.target.value })}
                className={INPUT_CLS}
                placeholder="e.g. MP0123456"
              />
            </FormField>

            <div className="pt-1">
              <SectionLabel>Payout destination</SectionLabel>
              <div className="flex gap-3">
                {(['practice', 'provider'] as const).map(opt => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => patchDraft({ payout_destination: opt })}
                    className={`flex-1 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
                      editDraft.payout_destination === opt
                        ? 'border-[#13294B] bg-[#13294B]/5 text-[#13294B]'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {opt === 'practice' ? 'Practice account' : "Provider's own account"}
                  </button>
                ))}
              </div>
            </div>

            {editDraft.payout_destination === 'provider' && (
              <div className="space-y-3 pt-1">
                <SectionLabel>Personal banking details</SectionLabel>
                <FormField label="Bank">
                  <select
                    value={editDraft.personal_bank_name}
                    onChange={e => patchDraft({ personal_bank_name: e.target.value })}
                    className={SELECT_CLS}
                  >
                    <option value="">Select bank</option>
                    {BANKS.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </FormField>
                <FormField label="Account holder">
                  <input type="text" value={editDraft.personal_account_holder} onChange={e => patchDraft({ personal_account_holder: e.target.value })} className={INPUT_CLS} />
                </FormField>
                <FormField label="Account number">
                  <input type="text" value={editDraft.personal_account_number} onChange={e => patchDraft({ personal_account_number: e.target.value })} className={INPUT_CLS} />
                </FormField>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Branch code">
                    <input type="text" value={editDraft.personal_branch_code} onChange={e => patchDraft({ personal_branch_code: e.target.value })} className={INPUT_CLS} />
                  </FormField>
                  <FormField label="Account type">
                    <select value={editDraft.personal_account_type} onChange={e => patchDraft({ personal_account_type: e.target.value })} className={SELECT_CLS}>
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

        {editError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {editError}
          </p>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={() => handleSaveEdit(m)}
            disabled={editLoading || wouldLoseLastManager}
            className="px-5 py-2 text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            {editLoading ? 'Saving…' : 'Save changes'}
          </button>
          <button
            onClick={closeEdit}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Add member form ────────────────────────────────────────────────────────
  function renderAddForm() {
    const isProvider = addDraft.memberRole === 'provider';

    return (
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-6 mb-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Add team member</h2>
          <button
            onClick={() => { setShowAdd(false); setAddDraft(BLANK_ADD); setAddError(null); }}
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
              { value: 'provider' as const, label: 'Doctor / Clinician', sub: 'Sees patients, has clinical details' },
              { value: 'manager' as const,  label: 'Admin staff',        sub: 'Manages billing and/or the practice' },
            ]).map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setAddDraft(d => ({ ...d, memberRole: opt.value }))}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  addDraft.memberRole === opt.value
                    ? 'border-[#13294B] bg-[#13294B]/5'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <p className={`text-sm font-semibold ${addDraft.memberRole === opt.value ? 'text-[#13294B]' : 'text-gray-800'}`}>{opt.label}</p>
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
              <input type="text" value={addDraft.firstName} onChange={e => setAddDraft(d => ({ ...d, firstName: e.target.value }))} className={INPUT_CLS} />
            </FormField>
            <FormField label="Last name">
              <input type="text" value={addDraft.lastName} onChange={e => setAddDraft(d => ({ ...d, lastName: e.target.value }))} className={INPUT_CLS} />
            </FormField>
          </div>
          <FormField label="Email address">
            <input type="email" value={addDraft.email} onChange={e => setAddDraft(d => ({ ...d, email: e.target.value }))} className={INPUT_CLS} placeholder="they@example.com" />
          </FormField>
          <FormField label="SA ID number">
            <input type="text" value={addDraft.saIdNumber} onChange={e => setAddDraft(d => ({ ...d, saIdNumber: e.target.value }))} className={INPUT_CLS} placeholder="13-digit ID number" maxLength={13} />
          </FormField>
        </div>

        {/* Permissions */}
        <div className="space-y-3">
          <SectionLabel>Permissions</SectionLabel>
          <FieldRow label="Can create bills">
            <YesNoToggle value={addDraft.canCreateBills} onChange={v => setAddDraft(d => ({ ...d, canCreateBills: v }))} />
          </FieldRow>
          <FieldRow label="Admin access">
            <YesNoToggle value={addDraft.canManagePractice} onChange={v => setAddDraft(d => ({ ...d, canManagePractice: v }))} />
          </FieldRow>
        </div>

        {/* Provider-only: clinical + payout */}
        {isProvider && (
          <>
            <div className="space-y-3 pt-2 border-t border-gray-100">
              <SectionLabel>Clinical details</SectionLabel>
              <FormField label="Specialty">
                <select value={addDraft.specialty} onChange={e => setAddDraft(d => ({ ...d, specialty: e.target.value }))} className={SELECT_CLS}>
                  <option value="">Select specialty</option>
                  {SPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </FormField>
              <FormField label="HPCSA number (optional)">
                <input type="text" value={addDraft.hpcsaNumber} onChange={e => setAddDraft(d => ({ ...d, hpcsaNumber: e.target.value }))} className={INPUT_CLS} placeholder="e.g. MP0123456" />
              </FormField>
            </div>

            <div className="space-y-3 pt-2 border-t border-gray-100">
              <SectionLabel>Payout destination</SectionLabel>
              <div className="flex gap-3">
                {(['practice', 'provider'] as const).map(opt => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setAddDraft(d => ({ ...d, payoutDestination: opt }))}
                    className={`flex-1 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
                      addDraft.payoutDestination === opt
                        ? 'border-[#13294B] bg-[#13294B]/5 text-[#13294B]'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {opt === 'practice' ? 'Practice account' : "Provider's own account"}
                  </button>
                ))}
              </div>

              {addDraft.payoutDestination === 'provider' && (
                <div className="space-y-3 pt-1">
                  <SectionLabel>Personal banking details</SectionLabel>
                  <FormField label="Bank">
                    <select value={addDraft.personalBankName} onChange={e => setAddDraft(d => ({ ...d, personalBankName: e.target.value }))} className={SELECT_CLS}>
                      <option value="">Select bank</option>
                      {BANKS.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Account holder">
                    <input type="text" value={addDraft.personalAccountHolder} onChange={e => setAddDraft(d => ({ ...d, personalAccountHolder: e.target.value }))} className={INPUT_CLS} />
                  </FormField>
                  <FormField label="Account number">
                    <input type="text" value={addDraft.personalAccountNumber} onChange={e => setAddDraft(d => ({ ...d, personalAccountNumber: e.target.value }))} className={INPUT_CLS} />
                  </FormField>
                  <div className="grid grid-cols-2 gap-3">
                    <FormField label="Branch code">
                      <input type="text" value={addDraft.personalBranchCode} onChange={e => setAddDraft(d => ({ ...d, personalBranchCode: e.target.value }))} className={INPUT_CLS} />
                    </FormField>
                    <FormField label="Account type">
                      <select value={addDraft.personalAccountType} onChange={e => setAddDraft(d => ({ ...d, personalAccountType: e.target.value }))} className={SELECT_CLS}>
                        <option value="">Select</option>
                        <option value="current">Current</option>
                        <option value="savings">Savings</option>
                      </select>
                    </FormField>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {addError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {addError}
          </p>
        )}

        <button
          onClick={handleAddMember}
          disabled={addLoading}
          className="w-full py-2.5 text-white text-sm font-semibold rounded-xl disabled:opacity-50 transition-all hover:shadow-lg"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {addLoading ? 'Sending invitation…' : 'Invite & add to practice'}
        </button>
      </div>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div>

      {/* Page heading */}
      <div className="flex items-start justify-between mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Practice Team</h1>
          <p className="mt-1 text-sm text-gray-500">
            {isManager ? 'Manage who has access to your practice.' : 'View your practice team.'}
          </p>
        </div>
        {isManager && !showAdd && (
          <button
            onClick={() => { setShowAdd(true); closeEdit(); setConfirmingId(null); }}
            className="shrink-0 rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            + Add team member
          </button>
        )}
      </div>

      {/* Self-elect-as-provider banner — only when the viewer is the admin
          whose own row is still role='admin' (i.e. not yet a clinician).
          Solo practitioners use this to satisfy the trading gate. */}
      {isManager && (() => {
        const me = members.find(m => m.user_id === currentUserId);
        if (!me || me.role !== 'admin') return null;
        return (
          <div className="mb-5">
            <SelfAsProviderCard />
          </div>
        );
      })()}

      {/* Flash banners */}
      {flashMsg && (
        <div className="mb-5 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800">
          {flashMsg}
        </div>
      )}
      {flashError && (
        <div className="mb-5 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {flashError}
        </div>
      )}

      {/* Add form */}
      {showAdd && renderAddForm()}

      {/* ── Section: Providers ── */}
      {activeProviders.length > 0 && (
        <div className="mb-8">
          <SectionLabel>Providers</SectionLabel>
          <div className="space-y-3">
            {activeProviders.map(m => renderCard(m))}
          </div>
        </div>
      )}

      {/* ── Section: Admin staff ── */}
      <div className="mb-8">
        <SectionLabel>Admin staff</SectionLabel>
        <div className="space-y-3">
          {meAsMember && meAsMember.role === 'admin' && renderCard(meAsMember, { isMe: true })}
          {otherAdmins.map(m => renderCard(m))}
          {!meAsMember && activeAdmins.length === 0 && (
            <p className="text-sm text-gray-400 py-4 text-center">No admin members.</p>
          )}
        </div>
      </div>

      {/* ── Section: Disabled ── */}
      {disabledMembers.length > 0 && (
        <div>
          <SectionLabel>Inactive members</SectionLabel>
          <div className="space-y-3">
            {disabledMembers.map(m => {
              const profile = getProfile(m);
              return (
                <div key={m.id} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 opacity-60">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-gray-700">{displayName(m)}</p>
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-gray-100 text-gray-500">
                          Disabled
                        </span>
                      </div>
                      <p className="text-sm text-gray-400 mt-0.5">{profile.email}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <RolePill role={m.role} />
                      {isManager && (
                        <button
                          onClick={() => handleEnable(m.id)}
                          disabled={actionLoading}
                          className="text-xs font-medium text-green-600 hover:text-green-800 transition-colors px-2 py-1 rounded-lg hover:bg-green-50 disabled:opacity-50"
                        >
                          Re-enable
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}
