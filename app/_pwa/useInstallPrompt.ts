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

// ─── The captured event lives at MODULE scope, not in a hook ───────────
//
// `beforeinstallprompt` fires ONCE, early, and only the listener attached
// at that moment sees it. While every consumer was mounted together that
// was invisible; it stopped being invisible when AccountInstallRow was
// added as the permanent way back after dismissing the install sheet. By
// the time a patient reaches Account, the event has long since fired and
// been captured by the layout's instance — a freshly mounted hook with its
// own useState started at null, reported 'none', and the row that exists
// precisely to be findable rendered nothing at all on Android.
//
// So the deferred event is stored once, for the page's lifetime, and hook
// instances subscribe to it. Listeners are attached a single time for the
// same reason: N mounted consumers must not race to preventDefault the
// same event.

let deferredEvent: BeforeInstallPromptEvent | null = null;
let appInstalled = false;
let listening = false;

const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((fn) => fn());

function startListening() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    // Suppress Chrome's own mini-infobar so our surfaces own the moment.
    e.preventDefault();
    deferredEvent = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    appInstalled = true;
    deferredEvent = null;
    notify();
  });
}

/**
 * Clear the module-level capture. TESTS ONLY.
 *
 * Page-lifetime state is right for the product — `beforeinstallprompt`
 * fires once per page and every consumer must see the same one — but a
 * test file is many "pages" in one module instance, so without this the
 * android case leaks a captured event into whatever runs next and the
 * appinstalled case leaves every later case reporting 'installed'. The
 * existing suite happened to order around both; that is luck, not
 * isolation, and the next test added to the file would have paid for it.
 */
export function __resetInstallPromptForTests() {
  deferredEvent = null;
  appInstalled  = false;
  subscribers.clear();
}

/**
 * The shared install lifecycle hook. Returns the current install state
 * and (when applicable) a function that triggers the real install.
 *
 * The hook does NOT persist dismissals — that's specific to the toast
 * surface. Placed callouts can persist freely.
 */
export function useInstallPrompt() {
  // A counter rather than the event itself: the event is module state, so
  // this only needs to make React re-read it.
  const [, forceRead]               = useState(0);
  const [installed,   setInstalled] = useState(false);
  // The iOS hint flag mirrors isIosSafari at mount — it never changes
  // during a page's lifetime so we don't need to re-check.
  const [iosHint,     setIosHint]   = useState(false);

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
      if (isAlreadyInstalled() || appInstalled) {
        setInstalled(true);
        return;
      }
      if (isIosSafari()) setIosHint(true);
      // The event may already have been captured before this instance
      // mounted — which is the entire point of the module-level store.
      if (deferredEvent) forceRead((n) => n + 1);
    })();

    startListening();
    const onChange = () => {
      if (appInstalled) setInstalled(true);
      forceRead((n) => n + 1);
    };
    subscribers.add(onChange);
    return () => {
      cancelled = true;
      subscribers.delete(onChange);
    };
  }, []);

  const state: InstallState =
      installed      ? 'installed'
    : deferredEvent  ? 'android'
    : iosHint        ? 'ios'
    :                  'none';

  // Trigger the install flow. Only meaningful when state === 'android'.
  // We mark our local state as installed once the choice resolves (the
  // appinstalled event also fires for an accepted prompt, but races
  // with our own UI; preempting feels nicer).
  const install = useCallback(async (): Promise<{ outcome?: 'accepted' | 'dismissed' }> => {
    const evt = deferredEvent;
    if (!evt) return {};
    try {
      await evt.prompt();
      const choice = await evt.userChoice;
      // Cleared for EVERY consumer: the event can only be prompted once,
      // so a second surface still offering "Install" would be a button
      // that silently does nothing.
      deferredEvent = null;
      notify();
      return { outcome: choice.outcome };
    } catch {
      // Chrome rejects an unsolicited prompt() — fall back to clearing
      // the deferred so the UI doesn't get stuck.
      deferredEvent = null;
      notify();
      return {};
    }
  }, []);

  return { state, install };
}
