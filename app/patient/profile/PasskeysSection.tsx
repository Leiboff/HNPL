'use client';

import { useState } from 'react';
import { usePasskeys, passkeyErrorMessage, type Passkey } from '@/lib/hooks/usePasskeys';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;
function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export default function PasskeysSection() {
  const { passkeys, loading, error, supported, register, rename, remove } = usePasskeys();
  const [adding,  setAdding]  = useState(false);
  const [notice,  setNotice]  = useState<string | null>(null);

  if (!supported) {
    return (
      <p className="text-sm text-gray-500">
        Passkeys aren’t supported in this browser. Try Safari, Chrome, or Edge on a recent device.
      </p>
    );
  }

  async function handleAdd() {
    setAdding(true);
    setNotice(null);
    const { ok, error: code } = await register();
    setAdding(false);
    if (ok) { setNotice('Passkey added.'); return; }
    if (code === 'user_cancelled') return;
    if (code) setNotice(passkeyErrorMessage(code));
  }

  return (
    <div className="space-y-4">
      {error && error !== 'user_cancelled' && (
        <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {passkeyErrorMessage(error)}
        </p>
      )}
      {notice && (
        <p className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-700">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : passkeys.length === 0 ? (
        <p className="text-sm text-gray-500">
          You haven’t added a passkey yet. Adding one lets you sign in with Face ID, fingerprint,
          or your device PIN.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
          {passkeys.map((p) => (
            <PasskeyRow
              key={p.id}
              passkey={p}
              isLast={passkeys.length === 1}
              onRename={(name) => rename(p.id, name)}
              onDelete={() => remove(p.id)}
              setNotice={setNotice}
            />
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={handleAdd}
        disabled={adding}
        className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
      >
        {adding ? 'Setting up…' : passkeys.length === 0 ? 'Add a passkey' : 'Add another passkey'}
      </button>
    </div>
  );
}

function PasskeyRow({
  passkey, isLast, onRename, onDelete, setNotice,
}: {
  passkey: Passkey;
  isLast: boolean;
  onRename: (name: string) => Promise<{ ok: boolean; error: unknown }>;
  onDelete: () => Promise<{ ok: boolean; error: unknown }>;
  setNotice: (n: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(passkey.friendly_name);
  const [saving,  setSaving]  = useState(false);

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === passkey.friendly_name) { setEditing(false); return; }
    setSaving(true);
    const { ok } = await onRename(trimmed);
    setSaving(false);
    if (ok) setEditing(false);
  }

  async function handleDelete() {
    const msg = isLast
      ? 'Delete this passkey? You’ll sign in with your email and password again.'
      : 'Delete this passkey? You won’t be able to sign in with this device anymore.';
    if (!window.confirm(msg)) return;
    const { ok } = await onDelete();
    if (ok && isLast) setNotice('Last passkey removed — you’ll sign in with email and password from now on.');
  }

  return (
    <li className="px-4 py-3 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draft}
              maxLength={120}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter')  handleSave();
                if (e.key === 'Escape') { setDraft(passkey.friendly_name); setEditing(false); }
              }}
              className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm outline-none focus:border-[#15A89E] focus:ring-2 focus:ring-[#15A89E]/20"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="text-xs font-medium text-[#13294B] hover:underline disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => { setDraft(passkey.friendly_name); setEditing(false); }}
              className="text-xs text-gray-500 hover:underline"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="font-medium text-sm text-gray-900 hover:text-[#13294B] truncate text-left"
          >
            {passkey.friendly_name || 'Unnamed passkey'}
          </button>
        )}
        <p className="text-xs text-gray-400 mt-0.5">
          Added {formatDate(passkey.created_at)}
          {passkey.last_used_at ? ` · Last used ${formatDate(passkey.last_used_at)}` : ''}
        </p>
      </div>
      <button
        type="button"
        onClick={handleDelete}
        className="text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 rounded-md px-2 py-1 transition-colors"
        aria-label="Delete passkey"
      >
        Delete
      </button>
    </li>
  );
}
