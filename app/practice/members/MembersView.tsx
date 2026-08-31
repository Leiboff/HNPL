'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  updateMember, disableMember, enableMember, addMember,
  addProviderToRoster, inviteLoginForProvider,
  type MemberUpdates, type NewMemberInput,
} from './actions';
import SelfAsProviderCard from './SelfAsProviderCard';
import AddMemberForm from './AddMemberForm';
import SpecialtyOptions from '@/components/SpecialtyOptions';
import AddProviderForm, { type AddProviderDraft } from './AddProviderForm';
import InviteLoginForm from './InviteLoginForm';

// ─── Types ────────────────────────────────────────────────────────────────────

type MemberProfile = { first_name: string; last_name: string; email: string };

export type MemberRow = {
  id:                      string;
  /**
   * NULL for a ROSTER practitioner — listed with name + specialty + HPCSA and
   * no auth account (migration 0091). Such a row authorises nothing: every
   * permission helper resolves through `user_id = auth.uid()`, which NULL
   * never matches.
   */
  user_id:                 string | null;
  /** Set only when user_id IS NULL — see 0091's identifiable constraint. */
  provider_first_name:     string | null;
  provider_last_name:      string | null;
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

// No payout/banking fields: payouts always go to the practice account, so
// this form cannot change where money lands. MemberRow above still CARRIES
// those columns (they're selected by the page and read by nothing else here)
// because the database keeps them for historical payout rows.
type EditDraft = {
  can_create_bills:    boolean;
  can_manage_practice: boolean;
  specialty:           string;
  hpcsa_number:        string;
};

type Props = {
  members:       MemberRow[];
  currentUserId: string;
  isManager:     boolean;
  practiceName:  string;
};

// The edit-mode specialty dropdown below renders <SpecialtyOptions>, the
// one vocabulary every surface shares (lib/specialties.ts). BANKS was
// only ever needed for the per-provider personal-banking fields, which
// are gone — practice banking is edited on /practice/details.

// ─── Primitive UI helpers ─────────────────────────────────────────────────────

const INPUT_CLS = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--portal-accent)]/30 focus:border-[var(--portal-accent)] transition-colors';
const SELECT_CLS = INPUT_CLS;

function RolePill({ role }: { role: 'admin' | 'provider' }) {
  return role === 'provider'
    ? <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-[var(--portal-ink)] text-white">Doctor / Practitioner</span>
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

/**
 * A member's name and email, from whichever of the two homes applies.
 *
 * With a login, both live on profiles. On a ROSTER row (user_id IS NULL) the
 * name lives on the membership itself and there is no email, because there is
 * no account — reported as NO_LOGIN_EMAIL rather than a blank, so the roster
 * state reads as deliberate instead of as missing data. 0091's constraint
 * guarantees exactly one of the two homes is populated, so this cannot show a
 * stale copy of a name.
 */
export const NO_LOGIN_EMAIL = 'No login';

function getProfile(m: MemberRow): MemberProfile {
  const p = Array.isArray(m.profile) ? m.profile[0] : m.profile;
  if (p) return p;
  if (m.provider_first_name || m.provider_last_name) {
    return {
      first_name: m.provider_first_name ?? '',
      last_name:  m.provider_last_name  ?? '',
      email:      NO_LOGIN_EMAIL,
    };
  }
  return { first_name: 'Unknown', last_name: 'User', email: '—' };
}

function displayName(m: MemberRow): string {
  const p = getProfile(m);
  return `${p.first_name} ${p.last_name}`.trim();
}

/** A practitioner on the roster with no auth account — invitable, later. */
export function isRosterOnly(m: MemberRow): boolean {
  return !m.user_id;
}

function countManagers(members: MemberRow[], excludeId?: string): number {
  return members.filter(m => m.active && m.can_manage_practice && m.id !== excludeId).length;
}

// Copy for the "Last manager" tag, matching the rule ACTUALLY enforced in
// code rather than a guess. Client: isLastManager = this member holds
// can_manage_practice AND countManagers(members, thisId) === 0, i.e. no
// OTHER *active* member holds can_manage_practice. Server enforces the
// identical count in both updateMember (rejecting the removal of
// can_manage_practice) and disableMember — see app/practice/members/
// actions.ts's two "Last manager guardrail" blocks.
//
// Note it hinges on the can_manage_practice CAPABILITY, not on the
// admin/provider role — which is why the tag legitimately appears on a
// doctor's row, the exact thing that made it confusing.
const LAST_MANAGER_EXPLAINER =
  'This is the only active member who can manage the practice. Every practice needs at '
  + 'least one, so they can\'t be disabled or have management rights removed until you give '
  + 'those rights to someone else.';

// ─── Main component ───────────────────────────────────────────────────────────

export default function MembersView({ members: initialMembers, currentUserId, isManager }: Props) {
  const router = useRouter();

  const [members,      setMembers]      = useState<MemberRow[]>(initialMembers);
  const [editingId,    setEditingId]    = useState<string | null>(null);
  const [editDraft,    setEditDraft]    = useState<EditDraft | null>(null);
  const [editError,    setEditError]    = useState<string | null>(null);
  const [editLoading,  setEditLoading]  = useState(false);

  const [showAdd,      setShowAdd]      = useState(false);
  const [showAddProvider, setShowAddProvider] = useState(false);
  /** Which roster row's "give them a login" form is open. */
  const [invitingId,   setInvitingId]   = useState<string | null>(null);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [actionLoading,setActionLoading]= useState(false);

  const [flashMsg,     setFlashMsg]     = useState<string | null>(null);
  const [flashError,   setFlashError]   = useState<string | null>(null);

  // Which row's "Last manager" explanation is expanded (tap/click path).
  const [lastManagerHelpId, setLastManagerHelpId] = useState<string | null>(null);

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
      specialty:    m.specialty    ?? '',
      hpcsa_number: m.hpcsa_number ?? '',
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
      updates.specialty    = editDraft.specialty    || null;
      updates.hpcsa_number = editDraft.hpcsa_number || null;
      // payout_destination and the five personal_bank_* fields are
      // deliberately NOT sent. Payouts always go to the practice account,
      // so this form has no business writing either — see the note beside
      // the destination copy below. Existing column values are left
      // untouched rather than nulled: a historical payouts row snapshotted
      // them, and clearing the source would make that row harder to audit.
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
        specialty:    'specialty'    in updates ? updates.specialty    ?? null : row.specialty,
        hpcsa_number: 'hpcsa_number' in updates ? updates.hpcsa_number ?? null : row.hpcsa_number,
        // payout_destination / personal_bank_* are never in `updates` any
        // more, so the row's existing values carry through untouched.
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

  // ── Add member submit — delegates to the shared AddMemberForm ─────────────
  async function handleAddMember(input: NewMemberInput): Promise<{ error: string | null }> {
    const result = await addMember(input);
    if (!result.error) {
      setShowAdd(false);
      flash(`Invitation sent to ${input.email}. The new member will appear below once processed.`);
      router.refresh();
    }
    return result;
  }

  // ── Add a practitioner to the roster — no email, no invite ────────────────
  //
  // A separate action and a separate form from the invite path above; see
  // ./AddProviderForm for why the two are not one component with a branch.
  async function handleAddProvider(draft: AddProviderDraft): Promise<{ error: string | null }> {
    const result = await addProviderToRoster(draft);
    if (!result.error) {
      setShowAddProvider(false);
      flash(`${draft.firstName.trim()} ${draft.lastName.trim()} added to your team.`);
      router.refresh();
    }
    return result;
  }

  // ── Give a rostered practitioner a login ──────────────────────────────────
  async function handleInviteLogin(m: MemberRow, email: string): Promise<{ error: string | null }> {
    const result = await inviteLoginForProvider(m.id, email);
    if (!result.error) {
      setInvitingId(null);
      flash(`Invitation sent to ${email.trim()}. ${displayName(m)} can sign in once they set a password.`);
      router.refresh();
    }
    return result;
  }

  // ── Card sub-render ────────────────────────────────────────────────────────
  function renderCard(m: MemberRow, opts: { isMe?: boolean } = {}) {
    const profile        = getProfile(m);
    const name           = displayName(m);
    const isEditing      = editingId === m.id;
    const isConfirming   = confirmingId === m.id;
    const isLastManager  = m.can_manage_practice && countManagers(members, m.id) === 0;
    const canDisable     = isManager && !opts.isMe && !isLastManager;
    const rosterOnly     = isRosterOnly(m);
    const isInviting     = invitingId === m.id;

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
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--portal-accent)] bg-[var(--portal-accent)]/10 rounded-full px-2 py-0.5">
                    You
                  </span>
                )}
                {/* A roster practitioner with no account. Stated positively —
                    this is a complete, intended state, not a pending invite. */}
                {rosterOnly && (
                  <span
                    data-testid="member-no-login-chip"
                    className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-100 rounded-full px-2 py-0.5"
                  >
                    No login
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
                  className="text-xs font-medium text-[var(--portal-accent)] hover:text-[var(--portal-ink)] transition-colors px-2 py-1 rounded-lg hover:bg-[var(--portal-accent)]/10"
                >
                  {isEditing ? 'Cancel' : 'Edit'}
                </button>
              )}
              {/* Optional, explicit, and only where it applies. */}
              {isManager && rosterOnly && m.active && !isEditing && (
                <button
                  onClick={() => setInvitingId(isInviting ? null : m.id)}
                  data-testid="invite-login-toggle"
                  className="text-xs font-medium text-[var(--portal-accent)] hover:text-[var(--portal-ink)] transition-colors px-2 py-1 rounded-lg hover:bg-[var(--portal-accent)]/10"
                >
                  {isInviting ? 'Cancel invite' : 'Give login'}
                </button>
              )}
              {canDisable && !isEditing && (
                <button
                  onClick={() => setConfirmingId(m.id)}
                  className="text-xs font-medium text-red-500 hover:text-red-700 transition-colors px-2 py-1 rounded-lg hover:bg-red-50"
                >
                  Disable
                </button>
              )}
              {/* "Last manager" replaces the Disable button (canDisable is
                  false whenever isLastManager is true), so without an
                  explanation it reads as an unexplained label on a row that
                  is mysteriously missing its action. Hover shows the reason
                  via title; tapping toggles it inline, since title never
                  fires on touch. */}
              {isManager && !opts.isMe && isLastManager && !isEditing && (
                <button
                  type="button"
                  onClick={() => setLastManagerHelpId(prev => (prev === m.id ? null : m.id))}
                  title={LAST_MANAGER_EXPLAINER}
                  aria-label={`Last manager. ${LAST_MANAGER_EXPLAINER}`}
                  aria-expanded={lastManagerHelpId === m.id}
                  data-testid={`last-manager-tag-${m.id}`}
                  className="text-[10px] text-gray-400 italic underline decoration-dotted underline-offset-2 hover:text-gray-600 cursor-help transition-colors"
                >
                  Last manager
                </button>
              )}
            </div>
          </div>

          {lastManagerHelpId === m.id && (
            <p
              role="note"
              data-testid={`last-manager-help-${m.id}`}
              className="mt-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-600"
            >
              {LAST_MANAGER_EXPLAINER}
            </p>
          )}

          {/* Give this practitioner a login — inline, on their own row, so
              there is no ambiguity about who is being invited. */}
          {isInviting && rosterOnly && (
            <InviteLoginForm
              memberName={name}
              onSubmit={(email) => handleInviteLogin(m, email)}
              onCancel={() => setInvitingId(null)}
            />
          )}

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
              <span className="text-xs text-gray-400">Payout: Practice account</span>
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
                <SpecialtyOptions placeholder="Select specialty" current={editDraft.specialty} />
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

            {/* Payout destination is no longer a per-member choice.
                Every plan pays into the PRACTICE's bank account: one
                practice = one bank account = one deposit, which is what
                lets a practice reconcile a weekly batch against their
                statement (migration 0090). The toggle and the personal
                banking fields that sat here are gone — the columns
                remain in the database so historical payouts stay
                reconcilable, but nothing writes them. */}
            <div className="pt-1">
              <SectionLabel>Payout destination</SectionLabel>
              <p className="text-sm text-gray-600" data-testid="member-payout-destination-note">
                Paid into the practice&apos;s bank account, with the rest of the
                practice&apos;s weekly payout.
              </p>
              <p className="mt-1 text-xs text-gray-400">
                Banking is set once for the whole practice under Practice details.
              </p>
            </div>
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
            style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
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
        {/* Two distinct actions, because they do genuinely different things.
            Adding a practitioner is the common one and needs no email, so it
            leads; inviting someone to a dashboard login is the deliberate
            second choice. Collapsing them into one button with a hidden mode
            switch is what made "add the third dentist" an email ceremony. */}
        <div className="shrink-0 flex flex-wrap gap-2">
          {isManager && !showAddProvider && (
            <button
              onClick={() => { setShowAddProvider(true); setShowAdd(false); closeEdit(); setConfirmingId(null); }}
              data-testid="add-provider-toggle"
              className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg"
              style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
            >
              + Add practitioner
            </button>
          )}
          {isManager && !showAdd && (
            <button
              onClick={() => { setShowAdd(true); setShowAddProvider(false); closeEdit(); setConfirmingId(null); }}
              className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-[var(--portal-ink)] transition-colors hover:bg-gray-50 hover:border-gray-400"
            >
              + Invite team member
            </button>
          )}
        </div>
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

      {/* Add form — shared component (mirrored on the brand-branch team view) */}
      {showAdd && (
        <AddMemberForm
          saIdRequired={true}
          onSubmit={handleAddMember}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {/* Roster form — separate component and separate action from the invite
          above; see ./AddProviderForm for why the two are not one. */}
      {showAddProvider && (
        <div className="mb-5">
          <AddProviderForm
            onSubmit={handleAddProvider}
            onCancel={() => setShowAddProvider(false)}
          />
        </div>
      )}

      {/* ── Section: Providers ── */}
      {activeProviders.length > 0 && (
        <div className="mb-8">
          <SectionLabel>Providers</SectionLabel>
          <div className="space-y-3">
            {activeProviders.map(m => renderCard(m))}
          </div>
        </div>
      )}

      {/* ── Section: Admin staff ──
          The empty state is keyed off what this section ACTUALLY renders
          (my own card, only when my role is 'admin', plus otherAdmins).
          It used to be `!meAsMember && activeAdmins.length === 0`, which
          required the viewer NOT to be a member of the practice at all —
          true only for a brand-admin. So a practice's own manager whose
          role is 'provider' (a solo practitioner, the common case) saw a
          bare "Admin staff" heading with nothing under it. */}
      {(() => {
        const showsMyAdminCard = !!meAsMember && meAsMember.role === 'admin';
        const adminCardCount   = (showsMyAdminCard ? 1 : 0) + otherAdmins.length;
        return (
          <div className="mb-8">
            <SectionLabel>Admin staff</SectionLabel>
            <div className="space-y-3">
              {showsMyAdminCard && renderCard(meAsMember!, { isMe: true })}
              {otherAdmins.map(m => renderCard(m))}
              {adminCardCount === 0 && (
                <div
                  data-testid="admin-staff-empty"
                  className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-5 py-6 text-center"
                >
                  <p className="text-sm font-medium text-gray-600">No admin staff added yet</p>
                  <p className="mt-1 text-xs text-gray-500">
                    Admin staff can create bills and manage the practice without being a
                    treating provider.
                  </p>
                  {/* Lower-emphasis on purpose. The header keeps the single
                      primary "+ Add team member"; this one is the
                      call-to-action for someone who just read "No admin
                      staff added yet", so it reads as part of that sentence
                      rather than a second identical primary button stacked
                      right below the first. Same action either way. */}
                  {isManager && !showAdd && (
                    <button
                      onClick={() => { setShowAdd(true); closeEdit(); setConfirmingId(null); }}
                      data-testid="admin-staff-empty-add"
                      className="mt-3 inline-flex rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-[var(--portal-ink)] transition-colors hover:bg-gray-100 hover:border-gray-400"
                    >
                      Add your first admin staff member
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })()}

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
