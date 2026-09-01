'use client';

import { useState } from 'react';
import SpecialtyOptions from '@/components/SpecialtyOptions';

// ─── Add a practitioner to the roster ───────────────────────────────────
//
// Name, specialty, HPCSA number. No email, no invite, no login.
//
// WHY A SEPARATE FORM FROM AddMemberForm
// ──────────────────────────────────────
// AddMemberForm is the invite flow, shared by the practice Team screen and the
// brand TeamSection, and it is explicitly out of scope for this work. Adding
// an "and sometimes there's no email" branch to it would have put the
// login-less path and the sends-mail-to-a-stranger path one conditional apart.
// This form shares what should be shared — <SpecialtyOptions>, so the two
// surfaces can never offer different specialties — and nothing else.
//
// HPCSA is REQUIRED here although it is optional at invite. An invited
// practitioner can be chased for it at /provider/setup; a roster entry has
// nobody to chase, so it is collected at the door or not at all. The server
// enforces the same rule — this is the affordance, not the guarantee.

export type AddProviderDraft = {
  firstName:   string;
  lastName:    string;
  specialty:   string;
  hpcsaNumber: string;
};

const EMPTY: AddProviderDraft = { firstName: '', lastName: '', specialty: '', hpcsaNumber: '' };

const INPUT_CLS =
  'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--portal-accent)]/30 focus:border-[var(--portal-accent)] transition-colors';

export default function AddProviderForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (draft: AddProviderDraft) => Promise<{ error: string | null }>;
  onCancel: () => void;
}) {
  const [draft,   setDraft]   = useState<AddProviderDraft>(EMPTY);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = <K extends keyof AddProviderDraft>(key: K, value: AddProviderDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const complete =
    draft.firstName.trim() && draft.lastName.trim() &&
    draft.specialty.trim() && draft.hpcsaNumber.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const result = await onSubmit(draft);
    setLoading(false);
    if (result.error) { setError(result.error); return; }
    setDraft(EMPTY);
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="add-provider-form"
      className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm space-y-4"
    >
      <div>
        <h3 className="text-base font-semibold text-gray-900">Add a practitioner</h3>
        <p className="mt-1 text-sm text-gray-500" data-testid="add-provider-no-login-note">
          They&apos;ll appear on your team and can be attached to bills. No email address
          needed &mdash; they don&apos;t get a login unless you choose to give them one later.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">First name</span>
          <input
            className={`mt-1 ${INPUT_CLS}`}
            value={draft.firstName}
            onChange={(e) => set('firstName', e.target.value)}
            aria-label="First name"
            required
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Last name</span>
          <input
            className={`mt-1 ${INPUT_CLS}`}
            value={draft.lastName}
            onChange={(e) => set('lastName', e.target.value)}
            aria-label="Last name"
            required
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Specialty</span>
          <select
            className={`mt-1 ${INPUT_CLS}`}
            value={draft.specialty}
            onChange={(e) => set('specialty', e.target.value)}
            aria-label="Specialty"
            required
          >
            <option value="">Select a specialty…</option>
            <SpecialtyOptions />
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">HPCSA number</span>
          <input
            className={`mt-1 ${INPUT_CLS}`}
            value={draft.hpcsaNumber}
            onChange={(e) => set('hpcsaNumber', e.target.value)}
            aria-label="HPCSA number"
            required
          />
        </label>
      </div>

      {error && (
        <p role="alert" data-testid="add-provider-error" className="text-sm text-red-600">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading || !complete}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 transition-opacity"
          style={{ backgroundColor: 'var(--portal-ink)' }}
        >
          {loading ? 'Adding…' : 'Add practitioner'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
