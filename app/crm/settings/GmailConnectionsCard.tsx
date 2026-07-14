'use client';

import { useState, useTransition } from 'react';
import type { ClientSafeGmailAccount } from './gmailAccountProjection';

// ─── /crm/settings — Gmail connections (multi-account) ────────────
//
// Lists every Gmail address the current user has connected. "Connect
// another" starts a fresh OAuth flow (Google's account chooser lets
// the user pick a different address). Per-row disconnect removes just
// that account. Reconnect on a reauth_required row restarts OAuth for
// the SAME address (Google will match by hint).

type Props = {
  accounts: ClientSafeGmailAccount[];
  connectedFlag: string | null;
  errorFlag:     string | null;
};

export default function GmailConnectionsCard({ accounts, connectedFlag, errorFlag }: Props) {
  const [pending, startTransition] = useTransition();
  const [inFlightId, setInFlightId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function disconnect(accountId: string, address: string) {
    if (!confirm(`Disconnect ${address}? You can reconnect any time.`)) return;
    setInFlightId(accountId);
    startTransition(async () => {
      setError(null);
      const res = await fetch('/api/crm/gmail/disconnect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ accountId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'disconnect_failed');
        setInFlightId(null);
        return;
      }
      window.location.reload();
    });
  }

  return (
    <div
      className="bg-white rounded-2xl border border-gray-200 p-5 space-y-4"
      data-testid="gmail-connections-card"
    >
      <div>
        <h2 className="text-sm font-semibold text-gray-900">Gmail connections</h2>
        <p className="text-xs text-gray-500 mt-1">
          Connect one or more Gmail addresses. Uses <code>gmail.send</code> and{' '}
          <code>gmail.readonly</code>. You can send from any connected address; replies to any of them are tracked.
        </p>
      </div>

      {connectedFlag && (
        <p className="text-xs text-emerald-700" data-testid="gmail-connected-flag">
          Connected as {connectedFlag}.
        </p>
      )}
      {errorFlag && (
        <p role="alert" className="text-xs text-red-700" data-testid="gmail-connect-error">
          Connection failed: {errorFlag}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">{error}</p>
      )}

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-3 text-xs text-gray-600" data-testid="gmail-no-accounts">
          No accounts connected yet.
        </div>
      ) : (
        <ul className="space-y-2" data-testid="gmail-accounts-list">
          {accounts.map(acc => (
            <li
              key={acc.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2.5"
              data-testid={`gmail-account-row:${acc.gmailAddress}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-gray-900 truncate">{acc.gmailAddress}</span>
                  {acc.status === 'connected' && (
                    <span className="inline-block rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px] px-2 py-0.5">Connected</span>
                  )}
                  {acc.status === 'reauth_required' && (
                    <span className="inline-block rounded-full bg-amber-50 text-amber-900 border border-amber-200 text-[10px] px-2 py-0.5" data-testid="gmail-reauth-required">Needs reconnect</span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-gray-500">
                  Connected {new Date(acc.connectedAt).toLocaleDateString()}
                  {acc.lastUsedAt && (
                    <> · Last send {new Date(acc.lastUsedAt).toLocaleDateString()}</>
                  )}
                  {acc.watchExpiresAt && (
                    <> · Push active</>
                  )}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                {acc.status === 'reauth_required' && (
                  <a
                    href="/api/crm/gmail/connect"
                    className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 px-2.5 py-1.5 text-xs"
                    data-testid={`gmail-reconnect:${acc.gmailAddress}`}
                  >
                    Reconnect
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => disconnect(acc.id, acc.gmailAddress)}
                  disabled={pending && inFlightId === acc.id}
                  className="rounded-lg border border-red-200 bg-white text-red-700 px-2.5 py-1.5 text-xs disabled:opacity-60"
                  data-testid={`gmail-disconnect:${acc.gmailAddress}`}
                >
                  {pending && inFlightId === acc.id ? 'Removing…' : 'Disconnect'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div>
        <a
          href="/api/crm/gmail/connect"
          className="inline-flex rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium"
          data-testid="gmail-connect-another"
        >
          {accounts.length === 0 ? 'Connect Gmail' : 'Connect another address'}
        </a>
      </div>
    </div>
  );
}
