'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type LogLine = { ts: string; level: 'info' | 'ok' | 'warn' | 'bad'; msg: string };

export default function PasskeySmokeClient({
  initialServerUserId,
}: {
  initialServerUserId: string | null;
}) {
  const [supported,  setSupported]  = useState<boolean | null>(null);
  const [logs,       setLogs]       = useState<LogLine[]>([]);
  const [busy,       setBusy]       = useState<string | null>(null);
  const [clientEmail, setClientEmail] = useState<string | null>(null);

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && !!window.PublicKeyCredential);
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      setClientEmail(user?.email ?? null);
    });
  }, []);

  function log(level: LogLine['level'], msg: string, extra?: unknown) {
    const ts = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { ts, level, msg }]);
    if (extra !== undefined) console.log(`[passkey-smoke] ${msg}`, extra);
    else                     console.log(`[passkey-smoke] ${msg}`);
  }

  async function withBusy<T>(label: string, fn: () => Promise<T>) {
    setBusy(label);
    try { return await fn(); }
    finally { setBusy(null); }
  }

  async function handleRegister() {
    await withBusy('register', async () => {
      log('info', 'registerPasskey() — starting');
      try {
const { data, error } = await createClient().auth.registerPasskey();
        if (error) { log('bad', `register error: ${error.message}`, error); return; }
        log('ok', `registered passkey id=${data?.id}`, data);
      } catch (err) {
        log('bad', `register threw: ${(err as Error).message}`, err);
      }
    });
  }

  async function handleSignInWithPasskey() {
    await withBusy('signin', async () => {
      log('info', 'signInWithPasskey() — starting');
      try {
        const { data, error } = await createClient().auth.signInWithPasskey();
        if (error) { log('bad', `signin error: ${error.message}`, error); return; }
        log('ok', `signed in as ${data?.user?.email}`, data);
        setClientEmail(data?.user?.email ?? null);
        log('info', 'Refresh the page to confirm the SSR session was set (server block at top should show your user).');
      } catch (err) {
        log('bad', `signin threw: ${(err as Error).message}`, err);
      }
    });
  }

  async function handleSignOut() {
    await withBusy('signout', async () => {
      log('info', 'signOut() — clearing session');
      const supabase = createClient();
      await supabase.auth.signOut();
      setClientEmail(null);
      log('ok', 'signed out — refresh to confirm SSR session is gone.');
    });
  }

  async function handleList() {
    await withBusy('list', async () => {
      log('info', 'passkey.list() — fetching');
      try {
        const { data, error } = await createClient().auth.passkey.list();
        if (error) { log('bad', `list error: ${error.message}`, error); return; }
        log('ok', `list ok (${data?.length ?? 0} passkeys)`, data);
      } catch (err) {
        log('bad', `list threw: ${(err as Error).message}`, err);
      }
    });
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          Browser context
        </p>
        <p className="mt-2 font-mono text-sm">
          window.PublicKeyCredential: {supported === null ? '(checking…)' : supported ? '✓ supported' : '✗ unavailable'}
        </p>
        <p className="mt-1 font-mono text-sm">
          client.auth.getUser(): {clientEmail ?? '(no client session)'}
        </p>
        <p className="mt-1 font-mono text-xs text-gray-500">
          initial server user id (this page load): {initialServerUserId ?? '(none)'}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Btn label="register"  busy={busy} onClick={handleRegister}            disabled={!supported || !clientEmail} />
        <Btn label="list"      busy={busy} onClick={handleList}                disabled={!clientEmail} />
        <Btn label="signout"   busy={busy} onClick={handleSignOut}             disabled={!clientEmail} />
        <Btn label="signin"    busy={busy} onClick={handleSignInWithPasskey}   disabled={!!clientEmail || !supported} />
      </div>

      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs space-y-1 min-h-30">
        {logs.length === 0 ? <p className="text-gray-400">(no log lines yet)</p> :
          logs.map((l, i) => (
            <p key={i} className={
              l.level === 'ok'   ? 'text-green-700' :
              l.level === 'bad'  ? 'text-red-700'   :
              l.level === 'warn' ? 'text-amber-700' : 'text-gray-700'
            }>
              [{l.ts}] {l.msg}
            </p>
          ))
        }
      </div>

      <p className="text-xs text-gray-500">
        Flow to test: (1) sign in via the regular login page first to get a server-side session.
        (2) Come back here, click <b>register</b>. (3) Click <b>signout</b>, then <b>signin</b>.
        (4) Refresh this page — the server-rendered block at the top should show your user
        after the passkey sign-in. That confirms SSR sees the session.
      </p>
    </section>
  );
}

function Btn({
  label, busy, onClick, disabled,
}: {
  label: string;
  busy: string | null;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const isBusy = busy === label;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isBusy}
      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {isBusy ? `${label}…` : label}
    </button>
  );
}
