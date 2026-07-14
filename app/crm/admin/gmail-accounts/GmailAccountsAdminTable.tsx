'use client';

import { Fragment, useState, useTransition } from 'react';
import { adminRevokeGmailAccount, adminAddSendAsAlias, adminRemoveSendAsAlias } from './actions';

export type AdminAliasRow = {
  id:            string;
  aliasEmail:    string;
  label:         string | null;
  allowedRoles:  string[];
  createdAt:     string;
};

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
  aliases:         AdminAliasRow[];
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
                <Fragment key={r.id}>
                  <tr data-testid={`admin-gmail-row:${r.gmailAddress}`}>
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
                  <tr className="bg-gray-50/50">
                    <td colSpan={8} className="px-3 py-2">
                      <AliasManager connectionId={r.id} aliases={r.aliases} />
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── AliasManager — per-connection alias add/remove ────────────────
//
// Admin-only actions. Server-side validates the caller's role again
// (belt-and-braces against a leaked API surface).

function AliasManager({
  connectionId, aliases,
}: {
  connectionId: string;
  aliases: AdminAliasRow[];
}) {
  const [pending, startTransition] = useTransition();
  const [newEmail, setNewEmail] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [roleSales, setRoleSales] = useState(false);
  const [roleAdmin, setRoleAdmin] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  function add() {
    const roles: Array<'sales' | 'admin'> = [];
    if (roleSales) roles.push('sales');
    if (roleAdmin) roles.push('admin');
    setErr(null);
    startTransition(async () => {
      const res = await adminAddSendAsAlias({
        connectionId, aliasEmail: newEmail, label: newLabel, allowedRoles: roles,
      });
      if (!res.ok) { setErr(res.error ?? 'add_failed'); return; }
      setNewEmail(''); setNewLabel('');
      window.location.reload();
    });
  }

  function remove(aliasId: string, aliasEmail: string) {
    if (!confirm(`Remove alias ${aliasEmail}? Users who relied on it lose access immediately.`)) return;
    setErr(null);
    startTransition(async () => {
      const res = await adminRemoveSendAsAlias({ aliasId });
      if (!res.ok) { setErr(res.error ?? 'remove_failed'); return; }
      window.location.reload();
    });
  }

  return (
    <div data-testid={`admin-aliases:${connectionId}`} className="space-y-2">
      <div className="text-[11px] font-semibold text-gray-600">Send-as aliases</div>
      {aliases.length === 0 ? (
        <p className="text-[11px] text-gray-500">No aliases attached to this connection.</p>
      ) : (
        <ul className="space-y-1">
          {aliases.map(a => (
            <li key={a.id} className="flex items-center gap-2 text-xs" data-testid={`admin-alias-row:${a.aliasEmail}`}>
              <span className="font-medium text-gray-900">{a.aliasEmail}</span>
              {a.label && <span className="text-gray-500">— {a.label}</span>}
              <span className="rounded-full border border-gray-200 bg-white text-gray-600 px-1.5 py-0.5 text-[10px]">
                {a.allowedRoles.join(', ') || '(no roles)'}
              </span>
              <button
                type="button"
                onClick={() => remove(a.id, a.aliasEmail)}
                disabled={pending}
                className="ml-auto rounded-md border border-red-200 bg-white text-red-700 px-2 py-0.5 text-[10px] disabled:opacity-60"
                data-testid={`admin-alias-remove:${a.aliasEmail}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="email"
          value={newEmail}
          onChange={e => setNewEmail(e.target.value)}
          placeholder="alias@betternow.co.za"
          className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs"
          data-testid={`admin-alias-email-input:${connectionId}`}
        />
        <input
          type="text"
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          placeholder="Label (optional)"
          className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs"
        />
        <label className="inline-flex items-center gap-1 text-[11px]">
          <input type="checkbox" checked={roleAdmin} onChange={e => setRoleAdmin(e.target.checked)} /> admin
        </label>
        <label className="inline-flex items-center gap-1 text-[11px]">
          <input type="checkbox" checked={roleSales} onChange={e => setRoleSales(e.target.checked)} /> sales
        </label>
        <button
          type="button"
          onClick={add}
          disabled={pending || !newEmail || (!roleSales && !roleAdmin)}
          className="rounded-md bg-[#13294B] text-white px-2 py-1 text-[11px] font-medium disabled:opacity-60"
          data-testid={`admin-alias-add:${connectionId}`}
        >
          {pending ? 'Adding…' : 'Add alias'}
        </button>
      </div>
      {err && <p className="text-[11px] text-red-700" data-testid="admin-alias-err">{err}</p>}
    </div>
  );
}
