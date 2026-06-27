'use client';

import { useState, useTransition } from 'react';

type GroupMemberRow = {
  user_id: string;
  role:    string;
  active:  boolean;
  profile: { first_name: string; last_name: string; email: string } | null;
};

type Props = {
  groupId:      string;
  admins:       GroupMemberRow[];
  grantAction:  (groupId: string, userId: string) => Promise<{ error: string | null }>;
  revokeAction: (groupId: string, userId: string) => Promise<{ error: string | null }>;
};

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

export default function GroupBrandAdminManager({ groupId, admins, grantAction, revokeAction }: Props) {
  const [userId,   setUserId]   = useState('');
  const [isPending, startTransition] = useTransition();
  const [message,  setMessage]  = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  function flash(kind: 'ok' | 'error', text: string) {
    setMessage({ kind, text });
  }

  function onGrant() {
    if (!userId.trim()) return;
    setMessage(null);
    startTransition(async () => {
      const r = await grantAction(groupId, userId.trim());
      if (r.error) flash('error', r.error);
      else { flash('ok', 'Brand admin granted.'); setUserId(''); }
    });
  }

  function onRevoke(uid: string) {
    setMessage(null);
    startTransition(async () => {
      const r = await revokeAction(groupId, uid);
      if (r.error) flash('error', r.error);
      else         flash('ok', 'Brand admin revoked.');
    });
  }

  const active = admins.filter((a) => a.active);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium text-gray-600 mb-2">Active brand admins ({active.length})</p>
        {active.length === 0 ? (
          <p className="text-sm text-gray-500">No brand admins yet.</p>
        ) : (
          <div className="space-y-1">
            {active.map((a) => (
              <div key={a.user_id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {a.profile ? `${a.profile.first_name} ${a.profile.last_name}`.trim() : a.user_id.slice(0, 8)}
                  </p>
                  <p className="text-xs text-gray-500 truncate">{a.profile?.email ?? '—'}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onRevoke(a.user_id)}
                  disabled={isPending}
                  className="text-xs text-red-700 hover:underline shrink-0 disabled:opacity-50"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-medium text-gray-600 mb-2">Grant by user id</p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="profile UUID"
            className={inputCls}
            disabled={isPending}
          />
          <button
            type="button"
            onClick={onGrant}
            disabled={isPending || !userId.trim()}
            className="rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            {isPending ? '…' : 'Grant'}
          </button>
        </div>
        <p className="text-[11px] text-gray-500 mt-1">
          Look the user up in /admin/customers — copy their User ID. Re-granting a revoked admin re-activates them.
        </p>
      </div>

      {message && (
        <p className={`text-xs ${message.kind === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
