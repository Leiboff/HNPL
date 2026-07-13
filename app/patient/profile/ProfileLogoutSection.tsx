'use client';

import { logoutAndRedirect } from '@/lib/auth/logout';

// ─── Profile logout section ─────────────────────────────────────────
//
// The Log out button was previously in the patient header; it now
// lives on the Profile page as a discrete section. Same underlying
// `logoutAndRedirect` helper, no change to the logout behaviour
// itself — only the placement moved.

export default function ProfileLogoutSection() {
  return (
    <div
      className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm p-5"
      data-testid="profile-logout-section"
    >
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-2"
        style={{ color: '#13294B', opacity: 0.6 }}
      >
        Session
      </p>
      <p className="text-sm text-gray-600 mb-3">
        Signed in on this device. You&apos;ll need to sign in again if you log out.
      </p>
      <button
        type="button"
        onClick={() => logoutAndRedirect()}
        data-testid="profile-logout-button"
        className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
      >
        Log out
      </button>
    </div>
  );
}
