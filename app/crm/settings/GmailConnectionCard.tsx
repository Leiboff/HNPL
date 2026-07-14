'use client';

import { useState, useTransition } from 'react';

type Account = {
  gmailAddress: string;
  status:       'connected' | 'reauth_required' | 'revoked';
  connectedAt:  string;
};

type Props = {
  account:       Account | null;
  connectedFlag: string | null;
  errorFlag:     string | null;
};

export default function GmailConnectionCard({ account, connectedFlag, errorFlag }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function disconnect() {
    if (!confirm('Disconnect Gmail? You\'ll need to reconnect to send email from the CRM.')) return;
    startTransition(async () => {
      setError(null);
      const res = await fetch('/api/crm/gmail/disconnect', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'disconnect_failed');
        return;
      }
      window.location.reload();
    });
  }

  return (
    <div
      className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3"
      data-testid="gmail-connection-card"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Gmail</h2>
          <p className="text-xs text-gray-500 mt-1">
            Connect a Gmail account so the CRM can send email from you and track replies. Uses <code>gmail.send</code> and <code>gmail.readonly</code> only.
          </p>
        </div>
      </div>

      {account && account.status === 'connected' ? (
        <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2 text-xs text-emerald-900">
          Connected as <strong>{account.gmailAddress}</strong>
        </div>
      ) : account && account.status === 'reauth_required' ? (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Gmail needs to be reconnected for <strong>{account.gmailAddress}</strong>. Click Connect to fix it.
        </div>
      ) : null}

      {connectedFlag && (
        <p className="text-xs text-emerald-700">Connected as {connectedFlag}.</p>
      )}
      {errorFlag && (
        <p role="alert" className="text-xs text-red-700">Connection failed: {errorFlag}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">{error}</p>
      )}

      <div className="flex gap-2">
        {account && account.status === 'connected' ? (
          <>
            <a
              href="/api/crm/gmail/connect"
              className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm"
              data-testid="gmail-reconnect"
            >
              Reconnect
            </a>
            <button
              type="button"
              onClick={disconnect}
              disabled={pending}
              className="rounded-lg border border-red-200 bg-white text-red-700 px-3 py-2 text-sm disabled:opacity-60"
              data-testid="gmail-disconnect"
            >
              {pending ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        ) : (
          <a
            href="/api/crm/gmail/connect"
            className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium"
            data-testid="gmail-connect"
          >
            Connect Gmail
          </a>
        )}
      </div>
    </div>
  );
}
