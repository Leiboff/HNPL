'use client';

import { useState } from 'react';
import { useInstallPrompt } from './useInstallPrompt';

// ─── InstallCallout — placed install affordance ──────────────────────────
//
// A deliberate inline element a page can place wherever an "Install
// BetterNow" call-to-action belongs (today: the login page, below the
// form). Persistent — unlike the toast it does not dismiss, because
// the patient hasn't been NAGGED into seeing it, they're looking at a
// page that puts it there on purpose.
//
// Detection comes from useInstallPrompt() — the same hook the toast
// uses, so the two surfaces never disagree about whether install is
// possible right now.
//
// What this is NOT:
//   • Not a third-party-store badge. BetterNow is a PWA; the install
//     goes through the browser's own install API, not through Apple
//     or Google's storefront. A storefront badge would be misleading
//     AND brand-wrong; see push-wiring.test.ts for the regression
//     that pins this absence.
//   • Not a primary CTA. Secondary visual weight: outline + ink-text,
//     not the navy→teal gradient reserved for the page's primary
//     action (signing in).
//
// Visibility rules:
//   • Already installed (display-mode standalone) → render nothing.
//   • Android with a captured beforeinstallprompt → button labelled
//     "Install BetterNow", click triggers the real install.
//   • iOS Safari → small hint card with the share-icon + Add to
//     Home Screen instruction (no JS API on iOS).
//   • Anything else (desktop without install API, in-app webview, etc.)
//     → render nothing. We do not pretend install is available where
//     it isn't.

type Variant = 'inline' | 'card';

type Props = {
  /**
   * "inline" — compact one-line treatment for surfaces with limited
   * room (under a form). "card" — slightly more padding + the same
   * monogram medallion the install toast uses, for surfaces with
   * dedicated space.
   */
  variant?: Variant;
};

const NAVY = '#13294B';
const TEAL = '#15A89E';

function Medallion() {
  return (
    <span className="inline-flex w-9 h-9 items-center justify-center rounded-xl bg-[radial-gradient(circle_at_30%_25%,#15A89E22,#13294B14_70%)] ring-1 ring-[#13294B]/10 text-[#13294B] shrink-0">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
        <rect x="6" y="3" width="12" height="18" rx="2" />
        <path d="M10 18h4" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path d="M12 3v12M8 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" strokeLinecap="round" />
    </svg>
  );
}

export default function InstallCallout({ variant = 'card' }: Props) {
  const { state, install } = useInstallPrompt();
  const [busy, setBusy] = useState(false);

  // Hide silently in cases where install isn't an option. NEVER show
  // a disabled button or a "your browser doesn't support" message —
  // that's clutter for the 90% who don't care.
  if (state === 'installed' || state === 'none') return null;

  async function onInstall() {
    setBusy(true);
    try {
      await install();
    } finally {
      setBusy(false);
    }
  }

  if (variant === 'inline') {
    if (state === 'android') {
      return (
        <button
          type="button"
          onClick={onInstall}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg border border-[#D8DEE8] bg-white px-3 py-2 text-sm font-medium text-[#13294B] hover:border-[#15A89E] hover:bg-[#15A89E]/5 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#15A89E]/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
            <rect x="6" y="3" width="12" height="18" rx="2" />
            <path d="M10 18h4" strokeLinecap="round" />
          </svg>
          {busy ? 'Installing…' : 'Install BetterNow'}
        </button>
      );
    }
    // iOS inline: a small caption rather than a button (no JS API).
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-[#3A4B66]">
        Tap <ShareIcon className="inline-block" /> then{' '}
        <span className="font-medium text-[#0F1F3A]">Add to Home Screen</span> to install.
      </p>
    );
  }

  // ── card variant ────────────────────────────────────────────────────
  return (
    <div
      role="region"
      aria-label="Install BetterNow"
      className="rounded-2xl border border-[#E5E9F0] bg-white p-4 sm:p-5 flex items-center gap-4 shadow-[0_1px_2px_rgba(15,31,58,0.04)]"
    >
      <Medallion />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[#0F1F3A]">Install BetterNow</p>
        {state === 'android' ? (
          <p className="mt-0.5 text-xs text-[#3A4B66]">
            Add it to your home screen — opens like an app, faster every time.
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-[#3A4B66]">
            Tap <ShareIcon className="inline-block -mt-0.5 align-middle" />
            {' '}then <span className="font-medium text-[#0F1F3A]">Add to Home Screen</span>.
          </p>
        )}
      </div>
      {state === 'android' && (
        <button
          type="button"
          onClick={onInstall}
          disabled={busy}
          // Outline-on-white — explicitly secondary so it doesn't
          // compete with the primary sign-in action above. The
          // navy→teal gradient is reserved for primary actions.
          className="shrink-0 rounded-lg border px-3.5 py-2 text-xs font-semibold text-[#13294B] hover:bg-[#15A89E]/5 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#15A89E]/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ borderColor: NAVY, color: NAVY }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = TEAL; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = NAVY; }}
        >
          {busy ? 'Installing…' : 'Install'}
        </button>
      )}
    </div>
  );
}
