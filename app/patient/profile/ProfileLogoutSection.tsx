'use client';

import { logoutAndRedirect } from '@/lib/auth/logout';

// ─── Sign out — body of the "Sign out" settings section ─────────────────
//
// Unchanged behaviour: the same `logoutAndRedirect` helper, called the same
// way. What changed is the chrome around it.
//
// This used to render its OWN white card with its own "Session" eyebrow
// label, which made it one of three competing patterns on the account page
// (a flat card here, accordions above it, a chevron nav-row between). It is
// now the body of a section in the single accordion system, so the card, the
// shadow and the eyebrow are gone — the section header supplies the title,
// and repeating it inside would be the same duplication the Passkeys
// sub-heading had.
//
// Being collapsed by default is also the progressive disclosure a destructive
// action wants: a red button no longer sits permanently on screen where a
// mis-tap can reach it, but it is one tap away and clearly labelled.

export default function ProfileLogoutSection() {
  return (
    <div className="flex flex-col gap-3" data-testid="profile-logout-section">
      <p className="text-[12.5px] leading-[1.55]" style={{ color: '#8496AA' }}>
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
