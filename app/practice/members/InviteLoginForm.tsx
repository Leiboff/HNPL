'use client';

import { useState } from 'react';

// ─── Give a rostered practitioner a login, later ────────────────────────
//
// The optional second step, and deliberately its own explicit action rather
// than something the roster form hints at: a practitioner on the roster is a
// complete, useful state, not a half-finished invite waiting to be chased.
//
// The copy states what the login DOES get them — their own bills — and by
// omission what it does not. A provider's signed-in view is informational: no
// banking, no team, no practice settings, and no money figures of their own.

const INPUT_CLS =
  'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--portal-accent)]/30 focus:border-[var(--portal-accent)] transition-colors';

export default function InviteLoginForm({
  memberName,
  onSubmit,
  onCancel,
}: {
  memberName: string;
  onSubmit: (email: string) => Promise<{ error: string | null }>;
  onCancel: () => void;
}) {
  const [email,   setEmail]   = useState('');
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const result = await onSubmit(email);
    setLoading(false);
    if (result.error) { setError(result.error); return; }
    setEmail('');
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="invite-login-form"
      className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3"
    >
      <div>
        <p className="text-sm font-semibold text-gray-900">Give {memberName} a login</p>
        <p className="mt-1 text-xs text-gray-500" data-testid="invite-login-scope-note">
          They&apos;ll get an email to set a password, and will be able to sign in and see
          their own bills and patients &mdash; nothing else. Banking, team and practice
          settings stay with you.
        </p>
      </div>

      <label className="block">
        <span className="text-xs font-medium text-gray-600">Their email address</span>
        <input
          type="email"
          className={`mt-1 ${INPUT_CLS}`}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Their email address"
          required
        />
      </label>

      {error && (
        <p role="alert" data-testid="invite-login-error" className="text-sm text-red-600">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading || !email.trim()}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 transition-opacity"
          style={{ backgroundColor: 'var(--portal-ink)' }}
        >
          {loading ? 'Sending…' : 'Send invitation'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
