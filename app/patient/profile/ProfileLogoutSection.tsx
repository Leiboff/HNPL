'use client';

import { logoutAndRedirect } from '@/lib/auth/logout';

// ─── Sign out — rendered at the bottom of AccountSettings ───────────────
//
// Unchanged behaviour: the same `logoutAndRedirect` helper, called the same
// way. What changed is the chrome around it and where it lives.
//
// This used to be its own screen behind a "Sign out" settings row
// (/patient/account/signout) — a whole navigable page for one red button and
// a line of copy. Direct product decision (2026-08-20): that was ceremony,
// not real friction, so it now renders directly at the bottom of
// AccountSettings instead. The button itself is still the deliberate tap a
// destructive action wants; a screen in front of it didn't add a second one.

export default function ProfileLogoutSection() {
  return (
    <div className="flex flex-col gap-3" data-testid="profile-logout-section">
      <p className="text-[12.5px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
        You&rsquo;re signed in on this device. Signing out here doesn&rsquo;t affect your
        other devices, and your saved cards and plans are untouched.
      </p>
      <button
        type="button"
        onClick={() => logoutAndRedirect()}
        data-testid="profile-logout-button"
        className="inline-flex w-fit items-center gap-1.5 rounded-xl border border-red-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-red-700 transition-colors hover:bg-red-50"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M15 17l5-5-5-5" />
          <path d="M20 12H9" />
          <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6" />
        </svg>
        Sign out
      </button>
    </div>
  );
}
