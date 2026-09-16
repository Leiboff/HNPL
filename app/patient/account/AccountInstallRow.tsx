'use client';

import { useInstallPrompt } from '@/app/_pwa/useInstallPrompt';

// ─── "Add betternow to your home screen" — the Account promo row ─────────
//
// A navy row at the foot of the settings list. It is the one PLACED entry
// point to installing the app: everything else about install is a toast
// that appears on its own schedule (app/_pwa/InstallPrompt.tsx) and is
// dismissible, which means a patient who dismissed it once had no way back.
// This row is the way back.
//
// It renders NOTHING when there is nothing to offer — already installed, or
// a browser with no install path at all (desktop, in-app webviews, Firefox
// mobile). Both come from the shared useInstallPrompt hook, so this row and
// the toast can never disagree about whether install is possible.
//
// On Android it calls the captured beforeinstallprompt event directly. On
// iOS Safari there is no such API, so it explains the Share → Add to Home
// Screen path instead — the honest thing, rather than a button that does
// nothing.

export default function AccountInstallRow() {
  const { state, install } = useInstallPrompt();

  if (state === 'installed' || state === 'none') return null;

  const isIos = state === 'ios';

  const body = (
    <>
      <span
        className="flex-none w-[38px] h-[38px] rounded-chip flex items-center justify-center"
        style={{ background: 'rgba(25,194,182,.18)', color: 'var(--brand-teal-bright)' }}
        aria-hidden
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M4 21h16" />
        </svg>
      </span>
      <span className="flex-1 min-w-0 text-left">
        <span className="block text-[14.5px] font-semibold text-white">
          Add betternow to your home screen
        </span>
        <span className="block mt-[3px] text-[12.5px]" style={{ color: 'rgba(255,255,255,.55)' }}>
          {/* Not "works offline" — see the note in app/_pwa/InstallPrompt:
              the service worker serves /offline rather than stale patient
              HTML, by design. */}
          {isIos
            ? 'Tap Share, then “Add to Home Screen”'
            : 'Opens instantly, always one tap away'}
        </span>
      </span>
    </>
  );

  // iOS has no programmatic install, so the row is a statement rather than
  // a control — and a button that cannot do the thing it names is worse
  // than no button.
  if (isIos) {
    return (
      <div
        className="rounded-card p-[18px] flex items-center gap-[14px]"
        style={{ background: 'var(--brand-navy-deep)' }}
        data-testid="account-install-row"
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => { void install(); }}
      className="rounded-card p-[18px] flex items-center gap-[14px] w-full"
      style={{ background: 'var(--brand-navy-deep)' }}
      data-testid="account-install-row"
    >
      {body}
    </button>
  );
}
