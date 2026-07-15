'use client';

import { useState, type TransitionStartFunction } from 'react';
import {
  addContact, updateContact, promotePrimary, removeContact,
  type LeadContact,
} from './contactsActions';

// ─── Contacts card — primary badged, add/edit/remove per contact ────
//
// Primary contact mirrors the lead's contact_first_name/last_name/
// phone/email/role_at_practice columns via DB triggers (0075). So
// every existing consumer (dedupe, CSV, public form, compose, list
// search, board card, inbound tray) keeps reading from crm_leads.

export default function ContactsCard({
  leadId, contacts, onChange, onError, onOk, pending, run,
}: {
  leadId: string;
  contacts: LeadContact[];
  onChange: (next: LeadContact[]) => void;
  onError: (msg: string) => void;
  onOk:    (msg: string) => void;
  pending: boolean;
  run:     TransitionStartFunction;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<null | { id: string; makePrimary: boolean }>(null);

  function submitAdd(form: ContactFormValues) {
    run(async () => {
      const res = await addContact({ lead_id: leadId, ...form });
      if (res.error || !res.contact) return onError(res.error ?? 'Add failed.');
      // If the newly-added contact is primary, the previous primary was
      // demoted server-side; reflect that locally too.
      onChange(res.contact.is_primary
        ? [res.contact, ...contacts.map(c => ({ ...c, is_primary: false }))]
        : [...contacts, res.contact],
      );
      setAdding(false);
      onOk('Contact added.');
    });
  }

  function submitEdit(id: string, form: ContactFormValues) {
    run(async () => {
      const res = await updateContact({ id, lead_id: leadId, ...form });
      if (res.error || !res.contact) return onError(res.error ?? 'Save failed.');
      onChange(contacts.map(c => c.id === id ? res.contact! : c));
      setEditingId(null);
      onOk('Saved.');
    });
  }

  function promote(id: string) {
    run(async () => {
      const res = await promotePrimary({ id, lead_id: leadId });
      if (res.error) return onError(res.error);
      onChange(contacts.map(c => ({ ...c, is_primary: c.id === id })));
      onOk('Primary updated.');
    });
  }

  function confirmedRemove(id: string, makePrimary: boolean) {
    run(async () => {
      // If we're removing the current primary, promote another first so
      // the DB guard allows the delete.
      if (makePrimary) {
        const nextPrimary = contacts.find(c => c.id !== id);
        if (!nextPrimary) return onError('Cannot remove the last contact.');
        const p = await promotePrimary({ id: nextPrimary.id, lead_id: leadId });
        if (p.error) return onError(p.error);
      }
      const res = await removeContact({ id, lead_id: leadId });
      if (res.error) return onError(res.error);
      onChange(contacts
        .filter(c => c.id !== id)
        .map(c => makePrimary && c.id !== id && !c.is_primary
          ? (c.id === contacts.find(x => x.id !== id)?.id ? { ...c, is_primary: true } : c)
          : c,
        ),
      );
      setRemoveConfirm(null);
      onOk('Removed.');
    });
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3" data-testid="contacts-card">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Contacts</h2>
          <p className="mt-0.5 text-xs text-gray-500">People at this practice. The primary drives the lead&rsquo;s headline contact and email compose.</p>
        </div>
        <button
          type="button"
          onClick={() => { setAdding(true); setEditingId(null); }}
          className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
          disabled={pending}
          data-testid="contacts-add"
        >
          + Add contact
        </button>
      </div>

      <ul className="divide-y divide-gray-100" data-testid="contacts-list">
        {contacts.map(c => (
          <li key={c.id} className="py-3" data-testid={`contact-row:${c.id}`}>
            {editingId === c.id ? (
              <ContactForm
                initial={c}
                onSubmit={(form) => submitEdit(c.id, form)}
                onCancel={() => setEditingId(null)}
                pending={pending}
                allowIsPrimary={false}
              />
            ) : (
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-gray-900">{c.first_name} {c.last_name}</p>
                  {c.is_primary && (
                    <span
                      className="inline-flex items-center rounded-full bg-[#15A89E]/10 text-[#0F766E] px-2 py-0.5 text-[10px] font-medium"
                      data-testid={`contact-primary-badge:${c.id}`}
                    >
                      PRIMARY
                    </span>
                  )}
                  {c.role_at_practice && (
                    <span className="text-[11px] text-gray-500">· {c.role_at_practice}</span>
                  )}
                </div>
                <div className="text-xs text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
                  {c.phone && (
                    <a
                      href={`tel:${c.phone}`}
                      className="hover:text-[#15A89E]"
                      data-testid={`contact-phone:${c.id}`}
                    >
                      📞 {c.phone}
                    </a>
                  )}
                  {c.email && (
                    <a
                      href={`mailto:${c.email}`}
                      className="hover:text-[#15A89E]"
                      data-testid={`contact-email:${c.id}`}
                    >
                      ✉ {c.email}
                    </a>
                  )}
                </div>
                {c.notes && (
                  <p className="text-[11px] text-gray-500 whitespace-pre-wrap">{c.notes}</p>
                )}
                <div className="flex gap-2 pt-1">
                  {!c.is_primary && (
                    <button
                      type="button"
                      onClick={() => promote(c.id)}
                      disabled={pending}
                      className="text-[11px] text-[#15A89E] hover:underline"
                      data-testid={`contact-promote:${c.id}`}
                    >
                      Make primary
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setEditingId(c.id)}
                    disabled={pending}
                    className="text-[11px] text-gray-600 hover:underline"
                    data-testid={`contact-edit:${c.id}`}
                  >
                    Edit
                  </button>
                  {contacts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setRemoveConfirm({ id: c.id, makePrimary: c.is_primary })}
                      disabled={pending}
                      className="text-[11px] text-red-700 hover:underline"
                      data-testid={`contact-remove:${c.id}`}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}

        {adding && (
          <li className="py-3" data-testid="contacts-new-form">
            <ContactForm
              initial={null}
              onSubmit={submitAdd}
              onCancel={() => setAdding(false)}
              pending={pending}
              allowIsPrimary
            />
          </li>
        )}
      </ul>

      {removeConfirm && (
        <div
          className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          data-testid="contact-remove-confirm"
        >
          <div className="bg-white rounded-2xl border border-gray-200 shadow-lg w-full max-w-md p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-900">Remove contact?</h3>
            <p className="text-xs text-gray-500">
              {removeConfirm.makePrimary
                ? 'This is the primary contact. We’ll promote the next contact to primary before removing this one.'
                : 'This contact will be removed from the practice record.'}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setRemoveConfirm(null)}
                disabled={pending}
                className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => confirmedRemove(removeConfirm.id, removeConfirm.makePrimary)}
                disabled={pending}
                className="rounded-lg bg-red-700 text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
                data-testid="contact-remove-confirm-ok"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ContactForm ─────────────────────────────────────────────────────

type ContactFormValues = {
  first_name:       string;
  last_name:        string;
  role_at_practice: string | null;
  phone:            string | null;
  email:            string | null;
  notes:            string | null;
  is_primary?:      boolean;
};

function ContactForm({
  initial, onSubmit, onCancel, pending, allowIsPrimary,
}: {
  initial: LeadContact | null;
  onSubmit: (form: ContactFormValues) => void;
  onCancel: () => void;
  pending: boolean;
  allowIsPrimary: boolean;
}) {
  const [firstName, setFirstName] = useState(initial?.first_name ?? '');
  const [lastName,  setLastName]  = useState(initial?.last_name  ?? '');
  const [role,      setRole]      = useState(initial?.role_at_practice ?? '');
  const [phone,     setPhone]     = useState(initial?.phone ?? '');
  const [email,     setEmail]     = useState(initial?.email ?? '');
  const [notes,     setNotes]     = useState(initial?.notes ?? '');
  const [isPrimary, setIsPrimary] = useState(false);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <FieldInput label="First name" value={firstName} onChange={setFirstName} required data-testid="contact-form-first" />
        <FieldInput label="Last name"  value={lastName}  onChange={setLastName}  required data-testid="contact-form-last" />
        <FieldInput label="Role"       value={role}      onChange={setRole}      placeholder="Receptionist, Practice manager, Doctor…" />
        <FieldInput label="Phone"      value={phone}     onChange={setPhone}     placeholder="+27 …" />
        <FieldInput label="Email"      value={email}     onChange={setEmail}     type="email" />
      </div>
      <label className="text-xs block">
        <span className="block font-medium text-gray-700 mb-1">Notes</span>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]"
        />
      </label>
      {allowIsPrimary && (
        <label className="flex items-center gap-2 text-xs text-gray-700">
          <input
            type="checkbox"
            checked={isPrimary}
            onChange={e => setIsPrimary(e.target.checked)}
            data-testid="contact-form-make-primary"
          />
          Make this the primary contact
        </label>
      )}
      <div className="flex gap-2 justify-end pt-1">
        <button type="button" onClick={onCancel} disabled={pending} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-1.5 text-xs">Cancel</button>
        <button
          type="button"
          onClick={() => onSubmit({
            first_name:       firstName,
            last_name:        lastName,
            role_at_practice: role.trim() || null,
            phone:            phone.trim() || null,
            email:            email.trim() || null,
            notes:            notes.trim() || null,
            is_primary:       allowIsPrimary && isPrimary,
          })}
          disabled={pending || !firstName.trim() || !lastName.trim()}
          className="rounded-lg bg-[#13294B] text-white px-3 py-1.5 text-xs font-medium disabled:opacity-60"
          data-testid="contact-form-save"
        >
          {initial ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function FieldInput({
  label, value, onChange, required, placeholder, type,
  'data-testid': testId,
}: {
  label: string; value: string; onChange: (v: string) => void;
  required?: boolean; placeholder?: string; type?: 'text' | 'email';
  'data-testid'?: string;
}) {
  return (
    <label className="text-xs">
      <span className="block font-medium text-gray-700 mb-1">
        {label}{required && <span className="text-red-500"> *</span>}
      </span>
      <input
        type={type ?? 'text'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        data-testid={testId}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]"
      />
    </label>
  );
}
