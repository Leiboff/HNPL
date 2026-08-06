'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { normalizePhoneZA } from '@/lib/validation';

// ─── Phone — edit-toggle field inside Personal details ────────────────
//
// Previously a separate accordion (own header, own body). Folded into
// Personal details as one of its fields with the same edit-toggle
// pattern as SalaryDaySection: display-only with a pencil affordance,
// tap → editable + Save / Cancel.
//
// Two behaviours match SalaryDaySection:
//   • The DISPLAYED value is a local mirror of the persisted phone — not
//     the `current` prop directly. On save we advance it immediately so
//     the row shows what was just saved (in canonical +27… form); the
//     router.refresh() re-fetches the server value and the mirror re-syncs
//     when the new prop lands. (Fixes the stale flash between "Saved." and
//     the refresh completing.)
//   • The number is validated as an SA mobile via the shared validator
//     (never an inline regex) — client blocks an invalid save, and the
//     server action re-validates as the real gate. Storage is E.164.

type Props = {
  current:       string | null;
  updateProfile: (data: { phone: string | null }) => Promise<{ error: string | null }>;
};

const inputCls =
  'rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

export default function PhoneField({ current, updateProfile }: Props) {
  const [editing, setEditing] = useState(false);
  const [phone,   setPhone]   = useState(current ?? '');
  const [savedPhone, setSavedPhone] = useState(current ?? '');
  const [error,   setError]   = useState<string | null>(null);
  const [okMsg,   setOkMsg]   = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => { setSavedPhone(current ?? ''); }, [current]);

  function reset() {
    setPhone(savedPhone);
    setError(null);
    setOkMsg(null);
    setEditing(false);
  }

  function onSave() {
    setError(null);
    setOkMsg(null);
    // Empty clears the number; anything else must be a valid SA mobile.
    const raw = phone.trim();
    const normalized = raw ? normalizePhoneZA(raw) : null;
    if (raw && !normalized) {
      setError('Enter a valid South African mobile number (e.g. 082 123 4567).');
      return;
    }
    startTransition(async () => {
      const r = await updateProfile({ phone: normalized });
      if (r.error) setError(r.error);
      else {
        // Reflect the saved (normalised) value immediately — no stale flash.
        setSavedPhone(normalized ?? '');
        setPhone(normalized ?? '');
        setOkMsg('Saved.');
        setEditing(false);
        router.refresh();
      }
    });
  }

  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#13294B', opacity: 0.45 }}>
        Phone
      </p>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              className={`${inputCls} w-full`}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="e.g. 082 000 0000"
              data-testid="profile-phone-input"
            />
          ) : (
            <p className="text-sm font-medium text-gray-800" data-testid="profile-phone-value">
              {savedPhone || '—'}
            </p>
          )}
        </div>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            data-testid="profile-phone-edit"
            aria-label="Edit phone"
            className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold hover:bg-gray-50"
            style={{ color: '#13294B' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
              <path d="M12 20h9" strokeLinecap="round" />
              <path d="m16.5 3.5 4 4L8 20l-4 1 1-4 11.5-13.5z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Edit
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={isPending}
              className="text-xs text-gray-500 hover:underline disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={isPending}
              data-testid="profile-phone-save"
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
      {error && <p className="mt-1.5 text-xs text-red-700">{error}</p>}
      {okMsg && <p className="mt-1.5 text-xs text-emerald-700">{okMsg}</p>}
    </div>
  );
}
