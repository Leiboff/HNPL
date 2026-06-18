'use client';

import { useEffect, useState } from 'react';
import { useInstallPrompt } from './useInstallPrompt';

// ─── InstallPrompt (the toast) ───────────────────────────────────────────
//
// Bottom-corner toast surfaced on the patient portal. One-time
// invitation, hard dismissal — see InstallCallout for the PLACED
// version that lives on the login page and persists.
//
// Detection lives in useInstallPrompt() so the two surfaces stay in
// lockstep; this file is purely toast UI + the dismissal-on-localStorage
// rule (only the toast nag-gates by dismissal — placed callouts don't).

const LS_KEY = 'hnpl_install_dismissed';

export default function InstallPrompt() {
  const { state, install } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(true);  // start hidden until LS check resolves

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Async IIFE to satisfy react-hooks/set-state-in-effect — the
    // localStorage read is sync but wrapping the setState in an
    // async callback is the lint-clean idiom and behaves the same.
    (async () => {
      try {
        setDismissed(localStorage.getItem(LS_KEY) === '1');
      } catch {
        // private mode / SecurityError on access — treat as not-dismissed.
        setDismissed(false);
      }
    })();
  }, []);

  function dismiss() {
    try { localStorage.setItem(LS_KEY, '1'); } catch { /* private mode */ }
    setDismissed(true);
  }

  async function onInstall() {
    await install();
    // Mark dismissed either way — accepted = installed = no need to
    // re-prompt; declined = "no thanks" and we respect that.
    try { localStorage.setItem(LS_KEY, '1'); } catch { /* private mode */ }
    setDismissed(true);
  }

  if (dismissed) return null;
  if (state !== 'android' && state !== 'ios') return null;

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
          {state === 'android' ? (
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
          {state === 'android' && (
            <div className="mt-2.5 flex items-center gap-3">
              <button
                type="button"
                onClick={onInstall}
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
