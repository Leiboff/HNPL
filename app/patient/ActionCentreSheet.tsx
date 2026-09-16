'use client';

import { useEffect, useState } from 'react';
import { usePasskeys, passkeyErrorMessage } from '@/lib/hooks/usePasskeys';
import { useInstallPrompt } from '@/app/_pwa/useInstallPrompt';
import { pushSupported, currentPushState, enablePush } from '@/app/_pwa/pushClient';
import BottomSheet, { SheetRow } from './BottomSheet';

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

  // Escape, the scroll lock, the scrim and close-on-navigation all live
  // in BottomSheet — see the note there on why all four belong together.

  if (!open) return null;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      label="Action centre"
      title="Notifications"
      blurb="One-time setup that makes betternow quicker and safer to use. Nothing here is required."
      testid="action-centre-sheet"
    >
      {/* ── Payment reminders ──────────────────────────────────────── */}
      <SheetRow
        testid="ac-item-push"
        tone={push === 'subscribed' ? 'teal' : 'neutral'}
        icon={<BellGlyph />}
        title="Turn on payment reminders"
        body={
          push === 'subscribed'   ? 'Reminders enabled — you\'ll get a nudge a day before each instalment.'
          : push === 'blocked'     ? 'Notifications are blocked in this browser. Turn them on in browser settings, then come back here.'
          : push === 'unsupported' ? 'Not supported in this browser.'
          :                          'A friendly nudge a day before each instalment — never more.'
        }
        aside={push === 'subscribed' ? <DoneMark /> : undefined}
        action={
          push === 'idle' || push === 'dismissed'
            ? { label: pushBusy ? 'Turning on…' : 'Turn on', onClick: turnOnPush, busy: pushBusy }
            : null
        }
        error={pushErr}
      />

      {/* ── Passkey enrolment ──────────────────────────────────────── */}
      <SheetRow
        testid="ac-item-passkey"
        tone={hasPasskey && !pkLoading ? 'teal' : 'neutral'}
        icon={<KeyGlyph />}
        title="Add a passkey"
        body={
          !pkSupported  ? 'Passkeys aren\'t supported on this device.'
          : hasPasskey  ? 'Passkey enrolled — you can sign in with a fingerprint or face.'
          :               'Skip typing your password — sign in with your device biometrics.'
        }
        aside={hasPasskey && !pkLoading ? <DoneMark /> : undefined}
        action={
          pkSupported && !hasPasskey && !pkLoading
            ? { label: pkBusy ? 'Enrolling…' : 'Add passkey', onClick: addPasskey, busy: pkBusy }
            : null
        }
        error={pkError ? passkeyErrorMessage(pkError) : null}
      />

      {/* ── Install the app ────────────────────────────────────────── */}
      {installState === 'installed' ? (
        <SheetRow
          testid="ac-item-install"
          tone="teal"
          icon={<InstallGlyph />}
          title="Install the app"
          body="Installed — you're launching from the home screen."
          aside={<DoneMark />}
        />
      ) : installState === 'android' ? (
        <SheetRow
          testid="ac-item-install"
          icon={<InstallGlyph />}
          title="Install the app"
          body="Add betternow to your home screen for one-tap access and native-feel navigation."
          action={{ label: installBusy ? 'Opening…' : 'Install', onClick: doInstall, busy: installBusy }}
        />
      ) : installState === 'ios' ? (
        <SheetRow
          testid="ac-item-install"
          icon={<InstallGlyph />}
          title="Install the app"
          body="Tap the Share icon in Safari, then Add to Home Screen."
        />
      ) : null /* 'none' → hidden entirely */}
    </BottomSheet>
  );
}

/** The done mark on a completed item. Subtle, and it never vanishes —
 *  an action centre that empties as you finish things looks broken, and a
 *  patient checking "did I turn reminders on?" needs the row still there
 *  saying yes. */
function DoneMark() {
  return (
    <>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden data-testid="ac-item-done" style={{ color: 'var(--portal-accent-ink)' }}>
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <span style={{ color: 'var(--portal-accent-ink)' }}>On</span>
    </>
  );
}

// ── Glyphs ────────────────────────────────────────────────────────
//
// 24×24, currentColor, so the tile's tone drives the tint.

function BellGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

function KeyGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="15" r="4" />
      <path d="M11.2 11.8 20 3M15.5 6.5l2.5 2.5M13 9l2 2" />
    </svg>
  );
}

function InstallGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 21h16" />
    </svg>
  );
}
