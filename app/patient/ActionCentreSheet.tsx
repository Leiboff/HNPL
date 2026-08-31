'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePasskeys, passkeyErrorMessage } from '@/lib/hooks/usePasskeys';
import { useInstallPrompt } from '@/app/_pwa/useInstallPrompt';
import { pushSupported, currentPushState, enablePush } from '@/app/_pwa/pushClient';

// ─── ActionCentreSheet ─────────────────────────────────────────────────
//
// Bottom-sheet / right-panel invoked from the patient header's bell
// button. Contains persistent one-time-setup items — reminders,
// passkey, install — that used to live inline on the home dashboard.
// Completed items render with a subtle tick so the centre never looks
// broken-empty.
//
// This component owns its own open/close state via props (the bell
// button in the header opens it). It does NOT change the frequency-
// capped interrupt-prompt behaviour elsewhere — the passkey item here
// is always visible until enrolled; the interrupt prompt stays on its
// login-count schedule.

type Props = {
  open:    boolean;
  onClose: () => void;
};

const LS_PUSH_KEY = 'hnpl_push_softask_dismissed';  // shared with PushSoftAsk

type PushState = 'unknown' | 'unsupported' | 'idle' | 'subscribed' | 'blocked' | 'dismissed';

export default function ActionCentreSheet({ open, onClose }: Props) {
  // ── Push state ───────────────────────────────────────────────────
  const [push, setPush] = useState<PushState>('unknown');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr,  setPushErr]  = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!pushSupported()) { setPush('unsupported'); return; }
    let cancelled = false;
    void (async () => {
      const state = await currentPushState();
      if (cancelled) return;
      if (state.kind === 'subscribed') { setPush('subscribed'); return; }
      if (state.kind === 'blocked')    { setPush('blocked');    return; }
      // 'idle' → check dismissal marker so the centre respects a
      // previous "not now" from the (now-removed) home soft-ask.
      try {
        if (typeof window !== 'undefined' && localStorage.getItem(LS_PUSH_KEY) === '1') {
          setPush('dismissed');
        } else {
          setPush('idle');
        }
      } catch { setPush('idle'); }
    })();
    return () => { cancelled = true; };
  }, [open]);

  async function turnOnPush() {
    setPushErr(null);
    setPushBusy(true);
    try {
      const next = await enablePush();
      if (next.kind === 'subscribed') {
        try { localStorage.setItem(LS_PUSH_KEY, '1'); } catch { /* private mode */ }
        setPush('subscribed');
      } else if (next.kind === 'blocked') {
        setPushErr('Notifications are blocked. Turn them on in your browser settings.');
        setPush('blocked');
      } else {
        setPushErr('Could not enable notifications. Try again in a moment.');
      }
    } finally {
      setPushBusy(false);
    }
  }

  // ── Passkey state ────────────────────────────────────────────────
  const { passkeys, loading: pkLoading, supported: pkSupported, register, error: pkError } = usePasskeys();
  const [pkBusy, setPkBusy] = useState(false);
  const hasPasskey = passkeys.length > 0;

  async function addPasskey() {
    setPkBusy(true);
    try { await register(); } finally { setPkBusy(false); }
  }

  // ── Install state ────────────────────────────────────────────────
  const { state: installState, install } = useInstallPrompt();
  const [installBusy, setInstallBusy] = useState(false);

  async function doInstall() {
    setInstallBusy(true);
    try { await install(); } finally { setInstallBusy(false); }
  }

  // ── ESC + scroll lock ────────────────────────────────────────────
  const onKey = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }, [onClose]);
  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onKey]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Action centre">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div className="absolute inset-0 flex flex-col justify-end md:items-end md:justify-start md:p-6">
        <div
          className="relative bg-white w-full md:max-w-md md:w-96 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto md:mt-16"
          data-testid="action-centre-sheet"
        >
          {/* Header */}
          <div className="sticky top-0 z-10 bg-white flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-900">Notifications</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="p-5 space-y-3">

            {/* ── Payment reminders ──────────────────────────────── */}
            <Item
              testid="ac-item-push"
              title="Turn on payment reminders"
              body={
                push === 'subscribed' ? 'Reminders enabled — you\'ll get a nudge a day before each instalment.'
                : push === 'blocked'    ? 'Notifications are blocked in this browser. Turn them on in browser settings, then come back here.'
                : push === 'unsupported' ? 'Not supported in this browser.'
                :                          'A friendly nudge a day before each instalment — never more.'
              }
              done={push === 'subscribed'}
              action={
                push === 'idle' || push === 'dismissed'
                  ? {
                      label: pushBusy ? 'Turning on…' : 'Turn on',
                      onClick: turnOnPush,
                      busy: pushBusy,
                    }
                  : null
              }
              error={pushErr}
            />

            {/* ── Passkey enrolment ──────────────────────────────── */}
            <Item
              testid="ac-item-passkey"
              title="Add a passkey"
              body={
                !pkSupported ? 'Passkeys aren\'t supported on this device.'
                : hasPasskey ? 'Passkey enrolled — you can sign in with a fingerprint or face.'
                :              'Skip typing your password — sign in with your device biometrics.'
              }
              done={hasPasskey && !pkLoading}
              action={
                pkSupported && !hasPasskey && !pkLoading
                  ? {
                      label: pkBusy ? 'Enrolling…' : 'Add passkey',
                      onClick: addPasskey,
                      busy: pkBusy,
                    }
                  : null
              }
              error={pkError ? passkeyErrorMessage(pkError) : null}
            />

            {/* ── Install the app ────────────────────────────────── */}
            {installState === 'installed' ? (
              <Item
                testid="ac-item-install"
                title="Install the app"
                body="Installed — you're launching from the home screen."
                done
                action={null}
              />
            ) : installState === 'android' ? (
              <Item
                testid="ac-item-install"
                title="Install the app"
                body="Add betternow to your home screen for one-tap access and native-feel navigation."
                done={false}
                action={{
                  label:   installBusy ? 'Opening…' : 'Install',
                  onClick: doInstall,
                  busy:    installBusy,
                }}
              />
            ) : installState === 'ios' ? (
              <Item
                testid="ac-item-install"
                title="Install the app"
                body="Tap the Share icon in Safari, then Add to Home Screen."
                done={false}
                action={null}
              />
            ) : null /* 'none' → hidden entirely */}

          </div>
        </div>
      </div>
    </div>
  );
}

// ── Item primitive ────────────────────────────────────────────────

type ItemProps = {
  testid: string;
  title:  string;
  body:   string;
  done:   boolean;
  action: { label: string; onClick: () => void; busy: boolean } | null;
  error?: string | null;
};

function Item({ testid, title, body, done, action, error }: ItemProps) {
  return (
    <div
      data-testid={testid}
      className={
        'rounded-xl border p-4 ' +
        (done
          ? 'border-emerald-100 bg-emerald-50/40'
          : 'border-gray-200 bg-white')
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
            {done && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden data-testid="ac-item-done">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            <span>{title}</span>
          </p>
          <p className="mt-1 text-xs text-gray-600">{body}</p>
          {error && (
            <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>
          )}
        </div>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            disabled={action.busy}
            className="shrink-0 rounded-lg text-xs font-semibold text-white px-3 py-2 disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
