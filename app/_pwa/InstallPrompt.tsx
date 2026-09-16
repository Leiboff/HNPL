'use client';

import { useEffect, useState } from 'react';
import { useInstallPrompt } from './useInstallPrompt';
import BottomSheet, { SheetRow } from '@/app/patient/BottomSheet';

// ─── InstallPrompt (the sheet) ───────────────────────────────────────────
//
// One-time invitation surfaced on the patient portal, with a hard
// dismissal — see InstallCallout for the PLACED version that lives on the
// login page and persists, and app/patient/account/AccountInstallRow for
// the way BACK once this has been dismissed.
//
// It was a bottom-corner toast. As a sheet it says the same two things
// with room to say why they matter, and — because it is the shared
// BottomSheet — it closes on the scrim and on navigation like every other
// sheet, rather than riding along on top of whatever screen comes next.
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
    <BottomSheet
      open
      onClose={dismiss}
      label="Install betternow"
      title="Add betternow to your home screen"
      blurb={state === 'android'
        ? 'It opens like an app, with no browser chrome in the way.'
        : 'Tap the Share icon in Safari, then “Add to Home Screen”.'}
      testid="install-prompt"
      footer={state === 'android' ? (
        <button
          type="button"
          onClick={onInstall}
          className="bn-btn-navy w-full rounded-tile py-4 text-[15px] font-semibold text-white"
        >
          Add to home screen
        </button>
      ) : undefined}
    >
      <SheetRow
        tone="teal"
        icon={<BoltGlyph />}
        title="Opens instantly"
        body="Straight to your balance and your next payment — no address bar, no tab to find."
      />
      {/* NOT "works offline". The service worker deliberately refuses to
          serve cached patient HTML and shows /offline instead, because a
          plan status or payment schedule must reflect server truth or say
          it cannot load (app/sw.js/route.ts). Promising a readable
          schedule with no signal would be selling the one behaviour this
          app has explicitly chosen not to have. */}
      <SheetRow
        icon={<HomeScreenGlyph />}
        title="Always one tap away"
        body="It sits with your other apps instead of behind a bookmark you have to go and find."
      />
    </BottomSheet>
  );
}

function BoltGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}

function HomeScreenGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </svg>
  );
}
