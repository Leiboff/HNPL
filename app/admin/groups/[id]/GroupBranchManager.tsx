'use client';

import { useState, useTransition } from 'react';

type BranchRow = {
  id:        string;
  name:      string;
  status:    string;
  city:      string | null;
  suburb:    string | null;
};

type Props = {
  groupId:             string;
  branches:            BranchRow[];
  standalonePractices: BranchRow[];
  assignAction:        (practiceId: string, groupId: string) => Promise<{ error: string | null }>;
  unassignAction:      (practiceId: string) => Promise<{ error: string | null }>;
};

const statusStyle = (s: string) =>
  s === 'approved'  ? 'bg-green-100 text-green-700' :
  s === 'pending'   ? 'bg-amber-100 text-amber-700' :
  s === 'suspended' ? 'bg-red-100 text-red-700' :
                      'bg-gray-100 text-gray-500';

export default function GroupBranchManager({
  groupId, branches, standalonePractices, assignAction, unassignAction,
}: Props) {
  const [assigning, setAssigning] = useState('');
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  function flash(kind: 'ok' | 'error', text: string) {
    setMessage({ kind, text });
  }

  function onAssign() {
    if (!assigning) return;
    setMessage(null);
    startTransition(async () => {
      const r = await assignAction(assigning, groupId);
      if (r.error) flash('error', r.error);
      else         { flash('ok', 'Branch added to group.'); setAssigning(''); }
    });
  }

  function onUnassign(practiceId: string) {
    setMessage(null);
    startTransition(async () => {
      const r = await unassignAction(practiceId);
      if (r.error) flash('error', r.error);
      else         flash('ok', 'Branch removed from group (now standalone).');
    });
  }

  return (
    <div className="space-y-4">
      {/* Existing branches */}
      <div>
        <p className="text-xs font-medium text-gray-600 mb-2">In this group ({branches.length})</p>
        {branches.length === 0 ? (
          <p className="text-sm text-gray-500">No branches in this group yet.</p>
        ) : (
          <div className="space-y-1">
            {branches.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{b.name}</p>
                  <p className="text-xs text-gray-500">{[b.suburb, b.city].filter(Boolean).join(', ') || '—'}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${statusStyle(b.status)}`}>
                    {b.status}
                  </span>
                  <button
                    type="button"
                    onClick={() => onUnassign(b.id)}
                    disabled={isPending}
                    className="text-xs text-red-700 hover:underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pull in a standalone practice */}
      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-medium text-gray-600 mb-2">Add an existing standalone practice</p>
        {standalonePractices.length === 0 ? (
          <p className="text-sm text-gray-500">No standalone practices available.</p>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={assigning}
              onChange={(e) => setAssigning(e.target.value)}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
              disabled={isPending}
            >
              <option value="">Choose a standalone practice…</option>
              {standalonePractices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.city ? `· ${p.city}` : ''} ({p.status})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onAssign}
              disabled={isPending || !assigning}
              className="rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {isPending ? '…' : 'Add'}
            </button>
          </div>
        )}
      </div>

      {message && (
        <p className={`text-xs ${message.kind === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
