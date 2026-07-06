'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// ─── Continue-with-Google button (patients only) ───────────────────────
//
// Kicks off Supabase's Google OAuth PKCE flow. The user is redirected to
// Google's consent screen; on return, Supabase Auth (dashboard-configured
// with the Google Client ID/Secret) exchanges the Google code and
// redirects back to our /auth/callback with a `?code=<pkce>&next=…`.
// From there the existing callback route handles code exchange, profile
// belt-and-braces provisioning, and the role dispatcher.
//
// Design notes:
//   • redirectTo is origin-derived at click time so the same code
//     works in dev (localhost:3000), staging, and prod. Hardcoded
//     `next=/dashboard` so the callback's safeNext clamps to a known
//     origin-relative destination — no user-tampered `?next=` here.
//   • This button is patient-context ONLY. Staff (practice / brand /
//     admin) sign in with email + password. Placement enforced by the
//     caller (rendered on /login with a clarifying label, and on
//     /signup/patient inline with the form).
//   • Google branding requires the white background + G logo + the
//     "Continue with Google" (or "Sign in with Google") text label,
//     UNMODIFIED. Do NOT restyle into brand navy/teal — Google's
//     guidelines specifically prohibit that treatment.

type Props = {
  /** "Continue with Google" (signup context) or "Sign in with Google" (login context). */
  label?: string;
  /** Optional aria-label override for testability. */
  ariaLabel?: string;
};

export default function ContinueWithGoogleButton({
  label = 'Continue with Google',
  ariaLabel,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const origin = typeof window !== 'undefined' ? window.location.origin : '';

    // redirectTo must be allowed in the Supabase dashboard's Auth →
    // URL Configuration → Redirect URLs list. `/auth/callback` is the
    // shared PKCE landing (see the password-reset build).
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${origin}/auth/callback?next=/dashboard`,
      },
    });

    if (err) {
      setError('Could not open the Google sign-in. Please try again.');
      setLoading(false);
      // Note: on the success path, the browser is navigated to Google
      // by signInWithOAuth — we never reach setLoading(false) here.
    }
  }

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        aria-label={ariaLabel ?? label}
        data-testid="continue-with-google"
        className="w-full flex items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        <GoogleGlyph />
        <span>{loading ? 'Opening Google…' : label}</span>
      </button>
      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ─── Google "G" glyph (official 4-colour) ─────────────────────────────

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.264h2.909c1.702-1.567 2.683-3.874 2.683-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.909-2.258c-.806.54-1.837.86-3.047.86-2.344 0-4.328-1.584-5.036-3.71H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.712A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.712V4.956H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.044l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.956L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  );
}
