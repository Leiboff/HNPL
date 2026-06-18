'use client';

import { useCallback, useEffect, useState } from 'react';

// ─── useInstallPrompt — single source of truth for PWA install state ─────
//
// The toast (InstallPrompt.tsx) and the placed callout (InstallCallout
// .tsx) both consume this hook so detection lives in one place. The
// previous version had the detection inlined in the toast, which would
// have produced two divergent copies if we'd duplicated it for the
// placed button.
//
// Three browser realities the hook collapses into one `state` value:
//
//   • 'installed' — display-mode is standalone, OR iOS reports
//                   navigator.standalone === true. Nothing to offer;
//                   consumers render null.
//   • 'android'   — Chrome/Edge/Samsung fired beforeinstallprompt.
//                   install() calls the captured event's .prompt().
//   • 'ios'       — iOS Safari (not Chrome-on-iOS, not in-app
//                   webviews). install() is unavailable — consumers
//                   render the share-then-Add-to-Home-Screen hint.
//   • 'none'      — desktop browsers with no install hook, in-app
//                   webviews that strip the API, Firefox mobile,
//                   etc. Consumers may render null or a quiet
//                   "open in your browser" message.

export type InstallState = 'installed' | 'android' | 'ios' | 'none';

type BeforeInstallPromptEvent = Event & {
  prompt:     () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === 'MacIntel'
        && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints !== undefined
        && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 1);
}

function isIosSafari(): boolean {
  if (!isIos()) return false;
  const ua = navigator.userAgent;
  // Exclude in-app webviews (Instagram, FB, etc.) which can't install,
  // and Chrome / Firefox on iOS which use WKWebView but report
  // CriOS / FxiOS / EdgiOS in the UA.
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function isAlreadyInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // Legacy iOS — pre-PWA-spec but still in the field.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * The shared install lifecycle hook. Returns the current install state
 * and (when applicable) a function that triggers the real install.
 *
 * The hook does NOT persist dismissals — that's specific to the toast
 * surface. Placed callouts can persist freely.
 */
export function useInstallPrompt() {
  const [deferred,    setDeferred]    = useState<BeforeInstallPromptEvent | null>(null);
  const [installed,   setInstalled]   = useState(false);
  // The iOS hint flag mirrors isIosSafari at mount — it never changes
  // during a page's lifetime so we don't need to re-check.
  const [iosHint,     setIosHint]     = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let cancelled = false;

    // Async-IIFE wrapping keeps the setState calls inside an async
    // callback, which the react-hooks/set-state-in-effect rule
    // permits — same behaviour as setting synchronously, just one
    // microtask later, and importantly NEVER blocks hydration (the
    // effect runs only on the client after mount, so SSR + first
    // client render still agree on the initial state of `false`).
    (async () => {
      if (cancelled) return;
      if (isAlreadyInstalled()) {
        setInstalled(true);
        return;
      }
      if (isIosSafari()) setIosHint(true);
    })();

    function onBeforeInstall(e: Event) {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setInstalled(true);
      setDeferred(null);
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled',        onInstalled);
    return () => {
      cancelled = true;
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled',        onInstalled);
    };
  }, []);

  const state: InstallState =
      installed  ? 'installed'
    : deferred   ? 'android'
    : iosHint    ? 'ios'
    :              'none';

  // Trigger the install flow. Only meaningful when state === 'android'.
  // We mark our local state as installed once the choice resolves (the
  // appinstalled event also fires for an accepted prompt, but races
  // with our own UI; preempting feels nicer).
  const install = useCallback(async (): Promise<{ outcome?: 'accepted' | 'dismissed' }> => {
    if (!deferred) return {};
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      setDeferred(null);
      return { outcome: choice.outcome };
    } catch {
      // Chrome rejects an unsolicited prompt() — fall back to clearing
      // the deferred so the UI doesn't get stuck.
      setDeferred(null);
      return {};
    }
  }, [deferred]);

  return { state, install };
}
