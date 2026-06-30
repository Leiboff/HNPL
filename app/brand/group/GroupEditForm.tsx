'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { UpdateGroupInput } from '@/app/brand/actions';

type Props = {
  groupId:         string;
  initialName:     string;
  initialLogoUrl:  string | null;
  saveAction:      (input: UpdateGroupInput) => Promise<{ error: string | null }>;
};

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

export default function GroupEditForm({ groupId, initialName, initialLogoUrl, saveAction }: Props) {
  const [name,    setName]    = useState(initialName);
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl ?? '');
  const [editing, setEditing] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [okMsg,   setOkMsg]   = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function reset() {
    setName(initialName);
    setLogoUrl(initialLogoUrl ?? '');
    setError(null);
    setOkMsg(null);
    setEditing(false);
  }

  function onSave() {
    setError(null);
    setOkMsg(null);
    startTransition(async () => {
      const r = await saveAction({
        groupId,
        name,
        logoUrl: logoUrl.trim() || null,
      });
      if (r.error) setError(r.error);
      else {
        setOkMsg('Saved.');
        setEditing(false);
        router.refresh();
      }
    });
  }

  return (
    <section className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold" style={{ color: '#13294B' }}>Display</h2>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            data-testid="group-edit"
            className="text-xs font-semibold underline underline-offset-2"
            style={{ color: '#13294B' }}
          >
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
              data-testid="group-save"
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Brand name</label>
          {editing ? (
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="group-name-input"
            />
          ) : (
            <p className="text-sm text-gray-900">{initialName || '—'}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Logo URL (optional)</label>
          {editing ? (
            <input
              className={inputCls}
              type="url"
              placeholder="https://…"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              data-testid="group-logo-input"
            />
          ) : (
            <p className="text-sm text-gray-900 break-all">{initialLogoUrl || '—'}</p>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-red-700">{error}</p>}
      {okMsg && <p className="text-xs text-emerald-700">{okMsg}</p>}
    </section>
  );
}
