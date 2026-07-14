'use client';

import { useState, useTransition } from 'react';
import { adminRevokeGmailAccount } from './actions';

export type AdminGmailAccountRow = {
  id:              string;
  userId:          string;
  userName:        string | null;
  userEmail:       string | null;
  gmailAddress:    string;
  status:          'connected' | 'reauth_required' | 'revoked';
  connectedAt:     string;
  lastUsedAt:      string | null;
  lastPolledAt:    string | null;
  watchExpiresAt:  string | null;
};

// ─── Admin oversight table ────────────────────────────────────────
//
// One row per connected Gmail account across the org. "Revoke" is
// destructive — confirmation dialog required. On success the row
// disappears (revalidate triggers a re-fetch).

type Props = { rows: AdminGmailAccountRow[] };

export default function GmailAccountsAdminTable({ rows }: Props) {
  const [pending, startTransition] = useTransition();
  const [inFlightId, setInFlightId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  function revoke(row: AdminGmailAccountRow) {
    const who = row.userName || row.userEmail || row.userId;
    const reason = prompt(`Revoke ${row.gmailAddress} (${who})?\n\nOptional reason for audit log:`, '');
    if (reason === null) return; // cancelled
    setInFlightId(row.id);
    setMsg(null);
    startTransition(async () => {
      const res = await adminRevokeGmailAccount({ accountId: row.id, reason });
      setInFlightId(null);
      if (!res.ok) { setMsg({ kind: 'err', text: res.error ?? 'revoke_failed' }); return; }
      setMsg({ kind: 'ok', text: `Revoked ${row.gmailAddress}.` });
      // Trigger a full refresh so the row disappears from the table.
      window.location.reload();
    });
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden" data-testid="admin-gmail-accounts">
      {msg && (
        <p
          role="alert"
          data-testid={msg.kind === 'ok' ? 'admin-revoke-ok' : 'admin-revoke-err'}
          className={`px-4 py-2 text-xs border-b ${msg.kind === 'ok' ? 'text-emerald-700 bg-emerald-50 border-emerald-100' : 'text-red-700 bg-red-50 border-red-100'}`}
        >
          {msg.text}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="p-6 text-sm text-gray-500">No Gmail accounts connected across the org.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="text-left px-3 py-2 font-medium">User</th>
                <th className="text-left px-3 py-2 font-medium">Gmail</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">Connected</th>
                <th className="text-left px-3 py-2 font-medium">Last send</th>
                <th className="text-left px-3 py-2 font-medium">Last poll</th>
                <th className="text-left px-3 py-2 font-medium">Watch expires</th>
                <th className="text-right px-3 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(r => (
                <tr key={r.id} data-testid={`admin-gmail-row:${r.gmailAddress}`}>
                  <td className="px-3 py-2">
                    <div className="text-sm text-gray-900">{r.userName ?? '(no name)'}</div>
                    <div className="text-[11px] text-gray-500">{r.userEmail ?? r.userId}</div>
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-900">{r.gmailAddress}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.status === 'connected'       && <span className="rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 px-2 py-0.5">Connected</span>}
                    {r.status === 'reauth_required' && <span className="rounded-full bg-amber-50 border border-amber-200 text-amber-900 px-2 py-0.5">Reauth</span>}
                    {r.status === 'revoked'         && <span className="rounded-full bg-gray-50 border border-gray-200 text-gray-700 px-2 py-0.5">Revoked</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">{new Date(r.connectedAt).toLocaleDateString()}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{r.lastUsedAt   ? new Date(r.lastUsedAt).toLocaleDateString()   : '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{r.lastPolledAt ? new Date(r.lastPolledAt).toLocaleDateString() : '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{r.watchExpiresAt ? new Date(r.watchExpiresAt).toLocaleDateString() : '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => revoke(r)}
                      disabled={pending && inFlightId === r.id}
                      className="rounded-lg border border-red-200 bg-white text-red-700 px-2.5 py-1.5 text-xs disabled:opacity-60"
                      data-testid={`admin-revoke:${r.gmailAddress}`}
                    >
                      {pending && inFlightId === r.id ? 'Revoking…' : 'Revoke'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
