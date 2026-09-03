'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { auditFactorEnrolled, auditFactorUnenrolled } from './actions';

// ─── Client-side TOTP enrolment / challenge / management ───────────────
//
// The factor mechanics MUST run in the browser: enroll() returns a secret
// and a QR the user scans, challenge()/verify() exchange a code the user
// reads off their phone. None of that can move to the server.
//
// Two Supabase behaviours are relied on and deliberately NOT reimplemented
// (they are server-side facts about the MFA API, documented here so a
// future reader does not "add" them):
//   • verifying a factor logs out all OTHER sessions and promotes THIS
//     session to aal2 — so a successful verify is the step-up.
//   • unenrolling a VERIFIED factor already requires an aal2 session — so
//     there is no separate "are you allowed to remove this" check to write.
//
// After any successful state change we re-read listFactors + AAL so the UI
// reflects the true server state rather than an optimistic guess.

type Step = 'enrol' | 'challenge' | 'manage';

type FactorRow = {
  id:            string;
  friendly_name?: string;
  factor_type:   string;
  status:        string;
};

type Props = {
  initialStep:       Step;
  currentLevel:      'aal1' | 'aal2';
  hasVerifiedFactor: boolean;
  nextPath:          string;
};

const FRIENDLY_NAME = 'Authenticator app';

export default function SecurityClient({ initialStep, nextPath }: Props) {
  const [step, setStep]           = useState<Step>(initialStep);
  const [factors, setFactors]     = useState<FactorRow[]>([]);
  const [qr, setQr]               = useState<string | null>(null);
  const [secret, setSecret]       = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [code, setCode]           = useState('');
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [notice, setNotice]       = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.auth.mfa.listFactors();
    const all = (data?.all ?? []) as FactorRow[];
    setFactors(all);
    return all;
  }, []);

  // Initial load of the factor list. refresh() setState is the whole point
  // of the effect (sync React state from the Supabase MFA API), which is the
  // legitimate case the set-state-in-effect rule cannot distinguish from a
  // render loop — the dependency is a stable useCallback, so it runs once.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); }, [refresh]);

  // ── Begin enrolment: create an unverified TOTP factor ────────────────
  const beginEnrol = useCallback(async () => {
    setError(null); setNotice(null); setBusy(true);
    try {
      const supabase = createClient();

      // A previous half-finished attempt leaves an UNVERIFIED factor that
      // blocks a fresh enrol with "factor already exists". Clear any
      // unverified ones first — never a verified one.
      const existing = await refresh();
      for (const f of existing) {
        if (f.factor_type === 'totp' && f.status === 'unverified') {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      }

      const { data, error: enrolErr } = await supabase.auth.mfa.enroll({
        factorType:   'totp',
        friendlyName: FRIENDLY_NAME,
      });
      if (enrolErr || !data) { setError(enrolErr?.message ?? 'Could not start enrolment.'); return; }

      // qr_code is an SVG string; render it as a data URI.
      setQr(`data:image/svg+xml;utf-8,${encodeURIComponent(data.totp.qr_code)}`);
      setSecret(data.totp.secret);
      setPendingId(data.id);
      setStep('enrol');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start enrolment.');
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  // ── Verify the newly-enrolled factor (promotes session to aal2) ──────
  const verifyEnrol = useCallback(async () => {
    if (!pendingId) return;
    setError(null); setBusy(true);
    try {
      const supabase = createClient();
      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: pendingId });
      if (chErr || !ch) { setError(chErr?.message ?? 'Could not create a challenge.'); return; }

      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId:    pendingId,
        challengeId: ch.id,
        code:        code.trim(),
      });
      if (vErr) { setError(vErr.message); return; }

      // Audit — server-side, best-effort. Does not gate the redirect.
      try { await auditFactorEnrolled({ factorId: pendingId, friendlyName: FRIENDLY_NAME }); } catch { /* logged server-side */ }

      setQr(null); setSecret(null); setPendingId(null); setCode('');
      // Session is now aal2. Send them where they were headed.
      window.location.href = nextPath;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setBusy(false);
    }
  }, [pendingId, code, nextPath]);

  // ── Re-challenge an existing verified factor (step-up / freshen) ─────
  const challengeExisting = useCallback(async () => {
    setError(null); setBusy(true);
    try {
      const supabase = createClient();
      const all = await refresh();
      const verified = all.find((f) => f.factor_type === 'totp' && f.status === 'verified');
      if (!verified) { setStep('enrol'); return; }

      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: verified.id });
      if (chErr || !ch) { setError(chErr?.message ?? 'Could not create a challenge.'); return; }

      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId:    verified.id,
        challengeId: ch.id,
        code:        code.trim(),
      });
      if (vErr) { setError(vErr.message); return; }

      setCode('');
      window.location.href = nextPath;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setBusy(false);
    }
  }, [code, nextPath, refresh]);

  // ── Unenrol a factor ─────────────────────────────────────────────────
  const unenrol = useCallback(async (factorId: string) => {
    setError(null); setNotice(null); setBusy(true);
    try {
      const supabase = createClient();
      const { error: uErr } = await supabase.auth.mfa.unenroll({ factorId });
      if (uErr) { setError(uErr.message); return; }
      try { await auditFactorUnenrolled({ factorId }); } catch { /* logged server-side */ }
      setNotice('Authenticator removed.');
      const all = await refresh();
      if (!all.some((f) => f.status === 'verified')) setStep('enrol');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the authenticator.');
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const verifiedFactors = factors.filter((f) => f.status === 'verified');

  return (
    <div className="mt-6 space-y-5">
      {error && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
          {notice}
        </div>
      )}

      {/* ── Challenge an existing factor (step-up) ── */}
      {step === 'challenge' && (
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">Enter your code</h2>
          <p className="mt-1 text-sm text-gray-600">
            Open your authenticator app and enter the current 6-digit code.
          </p>
          <CodeInput code={code} setCode={setCode} onSubmit={challengeExisting} busy={busy} />
          <div className="mt-3">
            <button
              type="button"
              onClick={challengeExisting}
              disabled={busy || code.trim().length < 6}
              className="rounded-lg bg-[#15A89E] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </div>
        </section>
      )}

      {/* ── Enrol a new factor ── */}
      {step === 'enrol' && (
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">Set up an authenticator app</h2>
          {!qr ? (
            <>
              <p className="mt-1 text-sm text-gray-600">
                Use Google Authenticator, 1Password, Authy or similar. You&apos;ll scan a QR
                code, then confirm with a 6-digit code.
              </p>
              <button
                type="button"
                onClick={beginEnrol}
                disabled={busy}
                className="mt-3 rounded-lg bg-[#15A89E] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Starting…' : 'Start setup'}
              </button>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-gray-600">Scan this with your authenticator app:</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="Authenticator QR code" className="mt-3 h-44 w-44" />
              {secret && (
                <p className="mt-2 text-xs text-gray-500">
                  Can&apos;t scan? Enter this key manually:{' '}
                  <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-gray-800">{secret}</code>
                </p>
              )}
              <p className="mt-4 text-sm text-gray-700">Enter the 6-digit code to finish:</p>
              <CodeInput code={code} setCode={setCode} onSubmit={verifyEnrol} busy={busy} />
              <div className="mt-3">
                <button
                  type="button"
                  onClick={verifyEnrol}
                  disabled={busy || code.trim().length < 6}
                  className="rounded-lg bg-[#15A89E] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy ? 'Verifying…' : 'Verify and enable'}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {/* ── Manage enrolled factors ── */}
      {step === 'manage' && (
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">Your authenticators</h2>
          {verifiedFactors.length === 0 ? (
            <p className="mt-1 text-sm text-gray-600">No verified authenticators.</p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-100">
              {verifiedFactors.map((f) => (
                <li key={f.id} className="flex items-center justify-between py-2">
                  <span className="text-sm text-gray-800">{f.friendly_name || 'Authenticator app'}</span>
                  <button
                    type="button"
                    onClick={() => unenrol(f.id)}
                    disabled={busy}
                    className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={beginEnrol}
            disabled={busy}
            className="mt-3 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            Add another authenticator
          </button>
        </section>
      )}
    </div>
  );
}

function CodeInput({
  code, setCode, onSubmit, busy,
}: {
  code: string;
  setCode: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <input
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={6}
      value={code}
      disabled={busy}
      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
      onKeyDown={(e) => { if (e.key === 'Enter' && code.trim().length >= 6) onSubmit(); }}
      placeholder="123456"
      className="mt-2 w-40 rounded-lg border border-gray-300 px-3 py-2 text-center font-mono text-lg tracking-widest"
      aria-label="Authentication code"
    />
  );
}
