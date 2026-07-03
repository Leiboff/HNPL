'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AddDoctorInput,
  UpdateDoctorInput,
} from '@/app/brand/actions';

// ─── Branch-detail: Doctors section ────────────────────────────────────
//
// Shows the branch's practitioner roster with active-status pills.
// Brand-admin actions: add doctor, edit specialty/HPCSA, deactivate,
// reactivate. NO access to the doctor's user account (email/password
// /profile) — this is a membership surface, not an identity one.
//
// Deactivating a doctor is REVERSIBLE (reactivate button appears);
// past bills/plans stay attributed. The discovery view filters
// active=TRUE so a deactivated doctor disappears from patient
// discovery on next view read.

export type DoctorRow = {
  memberId:    string;
  firstName:   string;
  lastName:    string;
  email:       string | null;
  specialty:   string | null;
  hpcsaNumber: string | null;
  active:      boolean;
};

export type DoctorActions = {
  addDoctor:        (input: AddDoctorInput)    => Promise<{ memberId: string | null; error: string | null }>;
  updateDoctor:     (input: UpdateDoctorInput) => Promise<{ error: string | null }>;
  deactivateDoctor: (memberId: string)         => Promise<{ error: string | null }>;
  reactivateDoctor: (memberId: string)         => Promise<{ error: string | null }>;
};

type Props = {
  practiceId: string;
  doctors:    DoctorRow[];
  actions:    DoctorActions;
};

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

export default function DoctorsSection({ practiceId, doctors, actions }: Props) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const activeDoctors   = doctors.filter((d) => d.active);
  const inactiveDoctors = doctors.filter((d) => !d.active);

  function refreshAfter(res: { error: string | null }, successMsg: string) {
    if (res.error) {
      setError(res.error);
      setOkMsg(null);
    } else {
      setError(null);
      setOkMsg(successMsg);
      setEditingId(null);
      setAdding(false);
      router.refresh();
    }
  }

  return (
    <section
      aria-labelledby="branch-doctors-heading"
      className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm p-5 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="branch-doctors-heading" className="text-sm font-semibold" style={{ color: '#13294B' }}>
          Doctors
        </h2>
        {!adding && (
          <button
            type="button"
            onClick={() => { setAdding(true); setError(null); setOkMsg(null); }}
            data-testid="brand-add-doctor"
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            + Add a doctor
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-700" role="alert">{error}</p>}
      {okMsg && <p className="text-xs text-emerald-700">{okMsg}</p>}

      {adding && (
        <AddDoctorForm
          practiceId={practiceId}
          onCancel={() => { setAdding(false); setError(null); }}
          isPending={isPending}
          onSubmit={(input) => {
            startTransition(async () => {
              const r = await actions.addDoctor(input);
              refreshAfter({ error: r.error }, `Invitation sent to ${input.email.trim()}.`);
            });
          }}
        />
      )}

      {/* Active doctors */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
          Active ({activeDoctors.length})
        </p>
        {activeDoctors.length === 0 ? (
          <p className="text-xs text-gray-500">No active doctors on this branch yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100" data-testid="brand-doctors-active">
            {activeDoctors.map((d) => (
              <DoctorRowUI
                key={d.memberId}
                doctor={d}
                editing={editingId === d.memberId}
                onEdit={() => { setEditingId(d.memberId); setError(null); setOkMsg(null); }}
                onCancel={() => setEditingId(null)}
                isPending={isPending}
                onSave={(input) => {
                  startTransition(async () => {
                    const r = await actions.updateDoctor(input);
                    refreshAfter(r, 'Saved.');
                  });
                }}
                onDeactivate={() => {
                  if (!confirm(`Deactivate ${d.firstName} ${d.lastName}? Past bills stay attributed; they disappear from patient discovery.`)) return;
                  startTransition(async () => {
                    const r = await actions.deactivateDoctor(d.memberId);
                    refreshAfter(r, 'Doctor deactivated.');
                  });
                }}
                onReactivate={undefined}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Inactive doctors */}
      {inactiveDoctors.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
            Deactivated ({inactiveDoctors.length})
          </p>
          <ul className="divide-y divide-gray-100" data-testid="brand-doctors-inactive">
            {inactiveDoctors.map((d) => (
              <DoctorRowUI
                key={d.memberId}
                doctor={d}
                editing={false}
                onEdit={() => {}}
                onCancel={() => {}}
                isPending={isPending}
                onSave={() => {}}
                onDeactivate={undefined}
                onReactivate={() => {
                  startTransition(async () => {
                    const r = await actions.reactivateDoctor(d.memberId);
                    refreshAfter(r, 'Doctor reactivated.');
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

// ─── Add doctor sub-form ───────────────────────────────────────────────

function AddDoctorForm({
  practiceId,
  isPending,
  onCancel,
  onSubmit,
}: {
  practiceId: string;
  isPending:  boolean;
  onCancel:   () => void;
  onSubmit:   (input: AddDoctorInput) => void;
}) {
  const [firstName,   setFirstName]   = useState('');
  const [lastName,    setLastName]    = useState('');
  const [email,       setEmail]       = useState('');
  const [specialty,   setSpecialty]   = useState('');
  const [hpcsaNumber, setHpcsaNumber] = useState('');

  return (
    <div className="rounded-xl border border-[rgba(19,41,75,.08)] bg-[#f7fbfb] p-4 space-y-3" data-testid="brand-add-doctor-form">
      <p className="text-sm font-semibold" style={{ color: '#13294B' }}>Invite a new doctor</p>
      <p className="text-xs text-gray-500">
        The doctor will receive an email invite. They complete their SA ID, banking, and password on {`/provider/setup`}.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Field label="First name">
          <input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} data-testid="doctor-firstname" />
        </Field>
        <Field label="Last name">
          <input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} data-testid="doctor-lastname" />
        </Field>
        <Field label="Email">
          <input type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="doctor-email" />
        </Field>
        <Field label="Specialty">
          <input className={inputCls} value={specialty} onChange={(e) => setSpecialty(e.target.value)} data-testid="doctor-specialty" />
        </Field>
        <Field label="HPCSA number">
          <input className={inputCls} value={hpcsaNumber} onChange={(e) => setHpcsaNumber(e.target.value)} data-testid="doctor-hpcsa" />
        </Field>
      </div>
      <div className="flex items-center justify-end gap-2">
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
          onClick={() => onSubmit({
            practiceId,
            firstName, lastName, email, specialty, hpcsaNumber,
          })}
          disabled={isPending}
          data-testid="doctor-invite-submit"
          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {isPending ? 'Sending…' : 'Send invitation'}
        </button>
      </div>
    </div>
  );
}

// ─── Row (view/edit) ───────────────────────────────────────────────────

function DoctorRowUI({
  doctor,
  editing,
  isPending,
  onEdit,
  onCancel,
  onSave,
  onDeactivate,
  onReactivate,
}: {
  doctor:       DoctorRow;
  editing:      boolean;
  isPending:    boolean;
  onEdit:       () => void;
  onCancel:     () => void;
  onSave:       (input: UpdateDoctorInput) => void;
  onDeactivate: (() => void) | undefined;
  onReactivate: (() => void) | undefined;
}) {
  const [specialty,   setSpecialty]   = useState(doctor.specialty   ?? '');
  const [hpcsaNumber, setHpcsaNumber] = useState(doctor.hpcsaNumber ?? '');

  return (
    <li className="py-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">
            {doctor.firstName} {doctor.lastName}
          </p>
          {editing ? (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Field label="Specialty">
                <input className={inputCls} value={specialty} onChange={(e) => setSpecialty(e.target.value)} data-testid={`doctor-edit-specialty-${doctor.memberId}`} />
              </Field>
              <Field label="HPCSA number">
                <input className={inputCls} value={hpcsaNumber} onChange={(e) => setHpcsaNumber(e.target.value)} data-testid={`doctor-edit-hpcsa-${doctor.memberId}`} />
              </Field>
            </div>
          ) : (
            <p className="text-xs text-gray-500 mt-0.5">
              {doctor.specialty || '—'} · HPCSA {doctor.hpcsaNumber || '—'}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 whitespace-nowrap">
          {!doctor.active && (
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
                  memberId:    doctor.memberId,
                  specialty:   specialty.trim() || null,
                  hpcsaNumber: hpcsaNumber.trim() || null,
                })}
                disabled={isPending}
                data-testid={`doctor-save-${doctor.memberId}`}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
              >
                {isPending ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <>
              {doctor.active && (
                <button
                  type="button"
                  onClick={onEdit}
                  data-testid={`doctor-edit-${doctor.memberId}`}
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
                  disabled={isPending}
                  data-testid={`doctor-deactivate-${doctor.memberId}`}
                  className="text-xs font-semibold text-red-700 hover:underline disabled:opacity-50"
                >
                  Deactivate
                </button>
              )}
              {onReactivate && (
                <button
                  type="button"
                  onClick={onReactivate}
                  disabled={isPending}
                  data-testid={`doctor-reactivate-${doctor.memberId}`}
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
