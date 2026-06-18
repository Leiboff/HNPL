'use client';

import { useEffect, useState } from 'react';
import {
  pushSupported,
  currentPushState,
  enablePush,
  disablePush,
  type PushState,
} from '@/app/_pwa/pushClient';

// ─── NotificationsToggle ─────────────────────────────────────────────────
//
// The single source of truth in settings for "do I get pushes?". The
// switch reflects the ACTUAL combined state of the browser permission
// + our server-stored subscription — not just a stored preference flag
// that could lie. Five cases the toggle handles honestly:
//
//   • unsupported            — browser has no push/notification API.
//                              Switch hidden, replaced with a hint.
//   • idle / granted-not-sub — patient hasn't subscribed (or cleared
//                              browser data). Switch reads "off";
//                              flipping it on requests permission and
//                              subscribes.
//   • blocked                — patient denied at OS level. Switch
//                              reads "off" and explains it can't be
//                              toggled on without going into browser
//                              settings. We do NOT pretend the switch
//                              works — the user is in control.
//   • subscribed             — switch reads "on". Flipping it off
//                              unsubscribes both sides idempotently.
//
// Keyboard accessibility: the underlying element is a button with
// role="switch" and aria-checked. Space + Enter toggle it.

export default function NotificationsToggle() {
  const [state,   setState]   = useState<PushState | null>(null);
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState<string | null>(null);

  // Initial state load + a refresh on visibilitychange. Coming back to
  // the tab after toggling OS-level permission elsewhere should reflect
  // the change without a manual reload.
  //
  // Single async `refresh()` handles both the "unsupported" and the
  // permission/subscription checks — keeps the effect's synchronous
  // body free of setState calls (which the react-hooks lint rightly
  // flags as a cascading-render smell), while letting the async
  // subscribe-and-set pattern stay clean.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      if (!pushSupported()) {
        if (alive) setState({ kind: 'unsupported' });
        return;
      }
      const s = await currentPushState();
      if (alive) setState(s);
    };
    refresh();
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const isOn = state?.kind === 'subscribed';
  const isBlocked = state?.kind === 'blocked';
  const isUnsupported = state?.kind === 'unsupported';
  const isLoading = state === null;

  async function toggle() {
    if (busy || isLoading || isUnsupported || isBlocked) return;
    setErr(null);
    setBusy(true);
    try {
      const next = isOn ? await disablePush() : await enablePush();
      setState(next);
      if (next.kind === 'blocked' && !isOn) {
        setErr('Notifications are blocked. Enable them in your browser settings to turn this on.');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[#0F1F3A]">Push notifications</p>
        <p className="mt-0.5 text-xs text-[#7A8AA0]">
          Payment reminders, confirmations, and anything that needs your attention.
        </p>
        {isBlocked && (
          <p className="mt-2 text-xs text-[#8A5A11]">
            Blocked in your browser. To turn this on, enable notifications for this site in your browser settings.
          </p>
        )}
        {isUnsupported && (
          <p className="mt-2 text-xs text-[#7A8AA0]">
            Your browser doesn&apos;t support push notifications.
            {' '}
            <span className="text-[#3A4B66]">
              Install BetterNow to your home screen on iOS, or open this in Chrome on Android.
            </span>
          </p>
        )}
        {err && (
          <p className="mt-2 text-xs text-[#8A1F1F]">{err}</p>
        )}
      </div>

      {!isUnsupported && (
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-label="Push notifications"
          aria-disabled={isBlocked || isLoading || busy}
          disabled={isBlocked || isLoading || busy}
          onClick={toggle}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-[#15A89E]/25 disabled:cursor-not-allowed disabled:opacity-60 ${
            isOn ? 'bg-[#15A89E]' : 'bg-[#D8DEE8]'
          }`}
        >
          <span
            aria-hidden
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${
              isOn ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      )}
    </div>
  );
}
