'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import AddMemberForm, { SPECIALTIES } from '@/app/practice/members/AddMemberForm';
import type {
  AddTeamMemberInput,
  UpdateTeamMemberInput,
} from '@/app/brand/actions';
import type { NewMemberInput } from '@/app/practice/members/actions';

// ─── Branch-detail: Team section ───────────────────────────────────────
//
// Manages the FULL team of a branch (admins + providers) from the
// brand surface. Add / edit / deactivate / reactivate any member.
// Uses the shared AddMemberForm (mirrored on /practice/members) so
// the fields, specialty list, and role picker stay in lockstep.
//
// Brick-prevention: refuse to deactivate or demote the LAST active
// admin. Enforced server-side; the UI also disables the toggle/button
// with an explanatory label so the user knows why.

export type TeamMemberRow = {
  memberId:          string;
  firstName:         string;
  lastName:          string;
  email:             string | null;
  role:              'admin' | 'provider' | 'staff';
  active:            boolean;
  canManagePractice: boolean;
  canCreateBills:    boolean;
  specialty:         string | null;
  hpcsaNumber:       string | null;
};

export type TeamActions = {
  addTeamMember:        (input: AddTeamMemberInput)    => Promise<{ memberId: string | null; error: string | null }>;
  updateTeamMember:     (input: UpdateTeamMemberInput) => Promise<{ error: string | null }>;
  deactivateTeamMember: (memberId: string)             => Promise<{ error: string | null }>;
  reactivateTeamMember: (memberId: string)             => Promise<{ error: string | null }>;
};

type Props = {
  practiceId:  string;
  members:     TeamMemberRow[];
  actions:     TeamActions;
};

const INPUT_CLS =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

export default function TeamSection({ practiceId, members, actions }: Props) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [flashOk, setFlashOk] = useState<string | null>(null);
  const [flashErr, setFlashErr] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const activeAdmins    = members.filter((m) => m.active && m.role !== 'provider');
  const activeProviders = members.filter((m) => m.active && m.role === 'provider');
  const inactive        = members.filter((m) => !m.active);

  const activeAdminCount = members.filter((m) => m.active && m.canManagePractice).length;

  function refreshAfter(res: { error: string | null }, okMsg: string) {
    if (res.error) {
      setFlashErr(res.error);
      setFlashOk(null);
    } else {
      setFlashOk(okMsg);
      setFlashErr(null);
      setEditingId(null);
      setAdding(false);
      router.refresh();
    }
  }

  async function handleAddSubmit(input: NewMemberInput): Promise<{ error: string | null }> {
    const r = await actions.addTeamMember({
      practiceId,
      memberRole:        input.memberRole,
      firstName:         input.firstName,
      lastName:          input.lastName,
      email:             input.email,
      canCreateBills:    input.canCreateBills,
      canManagePractice: input.canManagePractice,
      specialty:         input.specialty,
      hpcsaNumber:       input.hpcsaNumber,
    });
    if (!r.error) {
      setFlashOk(`Invitation sent to ${input.email.trim()}.`);
      setFlashErr(null);
      setAdding(false);
      router.refresh();
    }
    return { error: r.error };
  }

  return (
    <section
      aria-labelledby="branch-team-heading"
      className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm p-5 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="branch-team-heading" className="text-sm font-semibold" style={{ color: '#13294B' }}>
          Team
        </h2>
        {!adding && (
          <button
            type="button"
            onClick={() => { setAdding(true); setFlashErr(null); setFlashOk(null); }}
            data-testid="brand-add-team-member"
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            + Add a team member
          </button>
        )}
      </div>

      {flashErr && <p className="text-xs text-red-700" role="alert">{flashErr}</p>}
      {flashOk  && <p className="text-xs text-emerald-700">{flashOk}</p>}

      {adding && (
        <AddMemberForm
          saIdRequired={false}
          showPayoutFields={false}
          onSubmit={handleAddSubmit}
          onCancel={() => { setAdding(false); setFlashErr(null); }}
          submitLabel="Send invitation"
        />
      )}

      {/* Admin staff */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
          Admin staff ({activeAdmins.length})
        </p>
        {activeAdmins.length === 0 ? (
          <p className="text-xs text-gray-500">No admin members on this branch yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100" data-testid="brand-team-admins">
            {activeAdmins.map((m) => (
              <TeamRow
                key={m.memberId}
                member={m}
                editing={editingId === m.memberId}
                isOnlyAdmin={m.canManagePractice && activeAdminCount === 1}
                isPending={isPending}
                onEdit={() => { setEditingId(m.memberId); setFlashErr(null); setFlashOk(null); }}
                onCancel={() => setEditingId(null)}
                onSave={(input) => {
                  startTransition(async () => {
                    const r = await actions.updateTeamMember(input);
                    refreshAfter(r, 'Saved.');
                  });
                }}
                onDeactivate={() => {
                  if (!confirm(`Deactivate ${m.firstName} ${m.lastName}? They lose access immediately.`)) return;
                  startTransition(async () => {
                    const r = await actions.deactivateTeamMember(m.memberId);
                    refreshAfter(r, 'Member deactivated.');
                  });
                }}
                onReactivate={undefined}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Providers */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
          Practitioners ({activeProviders.length})
        </p>
        {activeProviders.length === 0 ? (
          <p className="text-xs text-gray-500">No practitioners on this branch yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100" data-testid="brand-team-providers">
            {activeProviders.map((m) => (
              <TeamRow
                key={m.memberId}
                member={m}
                editing={editingId === m.memberId}
                isOnlyAdmin={m.canManagePractice && activeAdminCount === 1}
                isPending={isPending}
                onEdit={() => { setEditingId(m.memberId); setFlashErr(null); setFlashOk(null); }}
                onCancel={() => setEditingId(null)}
                onSave={(input) => {
                  startTransition(async () => {
                    const r = await actions.updateTeamMember(input);
                    refreshAfter(r, 'Saved.');
                  });
                }}
                onDeactivate={() => {
                  if (!confirm(`Deactivate ${m.firstName} ${m.lastName}? Past bills stay attributed.`)) return;
                  startTransition(async () => {
                    const r = await actions.deactivateTeamMember(m.memberId);
                    refreshAfter(r, 'Member deactivated.');
                  });
                }}
                onReactivate={undefined}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Inactive */}
      {inactive.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
            Deactivated ({inactive.length})
          </p>
          <ul className="divide-y divide-gray-100" data-testid="brand-team-inactive">
            {inactive.map((m) => (
              <TeamRow
                key={m.memberId}
                member={m}
                editing={false}
                isOnlyAdmin={false}
                isPending={isPending}
                onEdit={() => {}}
                onCancel={() => {}}
                onSave={() => {}}
                onDeactivate={undefined}
                onReactivate={() => {
                  startTransition(async () => {
                    const r = await actions.reactivateTeamMember(m.memberId);
                    refreshAfter(r, 'Member reactivated.');
                  });
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ─── Row (view + inline edit) ──────────────────────────────────────────

function TeamRow({
  member,
  editing,
  isOnlyAdmin,
  isPending,
  onEdit,
  onCancel,
  onSave,
  onDeactivate,
  onReactivate,
}: {
  member:       TeamMemberRow;
  editing:      boolean;
  isOnlyAdmin:  boolean;
  isPending:    boolean;
  onEdit:       () => void;
  onCancel:     () => void;
  onSave:       (input: UpdateTeamMemberInput) => void;
  onDeactivate: (() => void) | undefined;
  onReactivate: (() => void) | undefined;
}) {
  const [specialty,        setSpecialty]        = useState(member.specialty   ?? '');
  const [hpcsaNumber,      setHpcsaNumber]      = useState(member.hpcsaNumber ?? '');
  const [canManage,        setCanManage]        = useState(member.canManagePractice);
  const [canCreateBills,   setCanCreateBills]   = useState(member.canCreateBills);

  const isProvider = member.role === 'provider';
  const wouldDemoteLastAdmin =
    member.canManagePractice && isOnlyAdmin && !canManage;

  return (
    <li className="py-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">
            {member.firstName} {member.lastName}
            <span className="ml-2 text-[11px] font-semibold uppercase tracking-widest text-gray-400">
              {isProvider ? 'Practitioner' : 'Admin staff'}
            </span>
          </p>

          {!editing && (
            <p className="text-xs text-gray-500 mt-0.5">
              {isProvider
                ? `${member.specialty || '—'} · HPCSA ${member.hpcsaNumber || '—'}`
                : (member.email || '—')
              }
              {' · '}
              {member.canManagePractice ? 'Admin access' : 'No admin'}
              {' · '}
              {member.canCreateBills ? 'Can create bills' : 'No bill create'}
            </p>
          )}

          {editing && (
            <div className="mt-2 space-y-2">
              {isProvider && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Field label="Specialty">
                    <select
                      className={INPUT_CLS}
                      value={specialty}
                      onChange={(e) => setSpecialty(e.target.value)}
                      data-testid={`team-edit-specialty-${member.memberId}`}
                    >
                      <option value="">Select specialty</option>
                      {SPECIALTIES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                  <Field label="HPCSA number">
                    <input
                      className={INPUT_CLS}
                      value={hpcsaNumber}
                      onChange={(e) => setHpcsaNumber(e.target.value)}
                      data-testid={`team-edit-hpcsa-${member.memberId}`}
                    />
                  </Field>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <ToggleRow
                  label="Admin access"
                  value={canManage}
                  onChange={setCanManage}
                  disabled={wouldDemoteLastAdmin}
                  testid={`team-edit-canManage-${member.memberId}`}
                />
                <ToggleRow
                  label="Can create bills"
                  value={canCreateBills}
                  onChange={setCanCreateBills}
                  testid={`team-edit-canCreateBills-${member.memberId}`}
                />
              </div>
              {wouldDemoteLastAdmin && (
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                  Every practice needs at least one active admin. Grant admin access to another member first.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 whitespace-nowrap">
          {!member.active && (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
              Deactivated
            </span>
          )}
          {editing ? (
            <>
              <button
                type="button"
                onClick={onCancel}
                disabled={isPending}
                className="text-xs text-gray-500 hover:underline disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onSave({
                  memberId:          member.memberId,
                  specialty:         isProvider ? (specialty.trim() || null)   : undefined,
                  hpcsaNumber:       isProvider ? (hpcsaNumber.trim() || null) : undefined,
                  canManagePractice: canManage,
                  canCreateBills:    canCreateBills,
                })}
                disabled={isPending || wouldDemoteLastAdmin}
                data-testid={`team-save-${member.memberId}`}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
              >
                {isPending ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <>
              {member.active && (
                <button
                  type="button"
                  onClick={onEdit}
                  data-testid={`team-edit-${member.memberId}`}
                  className="text-xs font-semibold underline underline-offset-2"
                  style={{ color: '#13294B' }}
                >
                  Edit
                </button>
              )}
              {onDeactivate && (
                <button
                  type="button"
                  onClick={onDeactivate}
                  disabled={isPending || isOnlyAdmin}
                  data-testid={`team-deactivate-${member.memberId}`}
                  title={isOnlyAdmin ? 'Every practice needs at least one active admin.' : undefined}
                  className="text-xs font-semibold text-red-700 hover:underline disabled:opacity-50 disabled:no-underline"
                >
                  Deactivate
                </button>
              )}
              {onReactivate && (
                <button
                  type="button"
                  onClick={onReactivate}
                  disabled={isPending}
                  data-testid={`team-reactivate-${member.memberId}`}
                  className="text-xs font-semibold text-emerald-700 hover:underline disabled:opacity-50"
                >
                  Reactivate
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

function ToggleRow({
  label, value, onChange, disabled, testid,
}: {
  label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean; testid?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2">
      <span className="text-xs text-gray-700">{label}</span>
      <div
        className={`flex rounded-full border overflow-hidden text-[11px] select-none ${disabled ? 'opacity-50 pointer-events-none' : 'border-gray-200'}`}
        data-testid={testid}
      >
        <button
          type="button"
          onClick={() => onChange(true)}
          className={`px-2.5 py-1 transition-colors ${value ? 'bg-green-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => onChange(false)}
          className={`px-2.5 py-1 transition-colors ${!value ? 'bg-red-500 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
        >
          No
        </button>
      </div>
    </div>
  );
}
