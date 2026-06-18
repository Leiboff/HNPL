'use client';

import { useEffect, useState } from 'react';

// ─── InstallPrompt ───────────────────────────────────────────────────────
//
// A tasteful one-time invitation to add BetterNow to the home screen.
// Lives at the bottom of the patient portal; never blocks content,
// never auto-opens the OS prompt, never reappears after dismissal.
//
// Two browser realities:
//
//   • Chrome / Edge / Samsung (Android, desktop):
//     fire `beforeinstallprompt` when the PWA is installable. We
//     stash that event, show our card, and only call .prompt() when
//     the user clicks "Install" — Chrome rejects an unsolicited
//     .prompt() now and the event is single-use.
//
//   • iOS Safari:
//     no `beforeinstallprompt`, no programmatic install. Detect iOS
//     Safari heuristically and show the share-then-Add-to-Home-Screen
//     hint instead. Once they've installed (display-mode: standalone),
//     stop showing the hint.
//
// Dismissal: persisted in localStorage. The card NEVER reappears for
// the same user/device after they X out — explicit anti-nag.
//
// We intentionally don't try to be clever about timing here. Mount it
// where it's relevant (the patient portal layout) and respect the
// user's "no thanks" forever.

const LS_KEY = 'hnpl_install_dismissed';

// Narrow type for the (still non-standard) install prompt event.
type BeforeInstallPromptEvent = Event & {
  prompt:        () => Promise<void>;
  userChoice:    Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPhone, iPad (including iPadOS 13+ which reports as Mac), iPod
  return /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 1);
}

function isIosSafari(): boolean {
  if (!isIos()) return false;
  const ua = navigator.userAgent;
  // Exclude in-app webviews (Instagram, FB, etc.) which can't install.
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function isAlreadyInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  // matchMedia covers most modern browsers; the legacy iOS fallback
  // checks navigator.standalone.
  return window.matchMedia?.('(display-mode: standalone)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export default function InstallPrompt() {
  const [deferred,  setDeferred]  = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint,   setIosHint]   = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Already installed? Nothing to show.
    if (isAlreadyInstalled()) {
      setInstalled(true);
      return;
    }
    // Dismissed previously? Respect that.
    if (localStorage.getItem(LS_KEY) === '1') return;

    // Android / Chrome path.
    function onBeforeInstall(e: Event) {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    // After successful install, hide ourselves immediately rather
    // than waiting for a page reload.
    function onInstalled() {
      setInstalled(true);
      setDeferred(null);
    }
    window.addEventListener('appinstalled', onInstalled);

    // iOS hint — present if the conditions allow installation.
    if (isIosSafari()) {
      setIosHint(true);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  function dismiss() {
    try { localStorage.setItem(LS_KEY, '1'); } catch { /* private mode */ }
    setDeferred(null);
    setIosHint(false);
  }

  async function install() {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      // The browser refused our prompt() (already-shown gesture, etc.)
      // — fall through and let the user dismiss.
    }
    setDeferred(null);
    // We mark dismissed either way — if they accepted, the appinstalled
    // event will hide it; if they declined, we don't re-ask.
    try { localStorage.setItem(LS_KEY, '1'); } catch { /* private mode */ }
  }

  if (installed) return null;
  if (!deferred && !iosHint) return null;

  return (
    <div
      role="region"
      aria-label="Install BetterNow"
      className="fixed bottom-3 left-3 right-3 sm:left-auto sm:right-5 sm:bottom-5 sm:max-w-sm z-40"
    >
      <div className="rounded-2xl border border-[#E5E9F0] bg-white p-4 shadow-[0_8px_24px_-12px_rgba(15,31,58,0.18)] flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-[radial-gradient(circle_at_30%_25%,#15A89E22,#13294B14_70%)] ring-1 ring-[#13294B]/10 flex items-center justify-center shrink-0 text-[#13294B]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <rect x="6" y="3" width="12" height="18" rx="2" />
            <path d="M10 18h4" strokeLinecap="round" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[#0F1F3A]">Install BetterNow</p>
          {deferred ? (
            <p className="mt-0.5 text-xs text-[#3A4B66]">
              Add it to your home screen so it opens like an app.
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-[#3A4B66]">
              Tap{' '}
              <svg className="inline-block -mt-0.5 mx-0.5 align-middle" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                <path d="M12 3v12M8 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" strokeLinecap="round" />
              </svg>
              {' '}then <span className="font-medium text-[#0F1F3A]">Add to Home Screen</span>.
            </p>
          )}
          {deferred && (
            <div className="mt-2.5 flex items-center gap-3">
              <button
                type="button"
                onClick={install}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white focus:outline-none focus-visible:ring-4 focus-visible:ring-[#15A89E]/30 transition-shadow"
                style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 140%)' }}
              >
                Install
              </button>
              <button
                type="button"
                onClick={dismiss}
                className="text-xs font-medium text-[#7A8AA0] hover:text-[#3A4B66]"
              >
                Not now
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="text-[#7A8AA0] hover:text-[#3A4B66] shrink-0 -mt-0.5 -mr-0.5"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
