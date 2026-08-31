'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import LastUsedPill from './LastUsedPill';

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
//
// ─── Consent ──────────────────────────────────────────────────────────
//
// A Google click is a SIGN-UP for anyone without an account — Supabase
// provisions the auth user and the 0024 trigger creates the profile — so
// no surface may offer it silently. Two props cover the two kinds of
// surface:
//
//   • showConsentNote (default true) — a DISCLOSURE. The right thing on
//     a sign-in screen like /login, where most arrivals already have an
//     account and taxing them with a tick would be noise.
//   • consentGiven / onConsentMissing — an AGREEMENT. /signup passes
//     these: it is where accounts are made, so it collects an unticked
//     box that gates both this button and the email route, and carries
//     the result to /auth/callback to be recorded.
//
// Set showConsentNote={false} only when the caller provides one of the
// two itself — never to drop the disclosure entirely. The enumeration of
// every caller and which shape it takes lives in
// app/oauth-terms-consent.test.ts.

type Props = {
  /** "Continue with Google" (signup context) or "Sign in with Google" (login context). */
  label?: string;
  /** Optional aria-label override for testability. */
  ariaLabel?: string;
  /**
   * Optional post-auth destination — plumbed through to
   * `/auth/callback?next=…`. Must be an origin-relative path;
   * anything else is clamped to '/dashboard' by /auth/callback's
   * safeNext. Caller-supplied only in narrow flows (e.g. the
   * emailed-bill-link routing rule, /login preserving its own
   * ?next= param). Default: '/dashboard' — same as before.
   */
  next?: string;
  /**
   * Called right before the browser navigates away to Google — not on
   * confirmed success, because a full-page OAuth redirect has no
   * client-side "it worked" callback to hook. /login uses this to record
   * "last sign-in method: Google" (lib/auth/lastSignInMethod.ts); every
   * other caller (signup) simply leaves it unset. Not called at all when
   * signInWithOAuth itself errors before the redirect.
   */
  onSignInAttempt?: () => void;
  /**
   * True when this WAS the last method that succeeded on this browser —
   * /login's own concern (lib/auth/lastSignInMethod.ts), threaded in as a
   * prop rather than read here, so this component stays unaware of the
   * "last used" feature entirely. Swaps the border for the same teal ring
   * used on the highlighted passkey button and password form.
   */
  highlighted?: boolean;
  /**
   * Render the "By continuing… Terms & Privacy" line beneath the button.
   * Defaults to TRUE — the disclosure is the thing that makes the
   * acceptance /auth/callback records honest. Set false only when the
   * caller renders an equivalent line covering this button (the /signup
   * entry screen puts one under its whole button stack).
   */
  showConsentNote?: boolean;
  /**
   * Which ground this button is sitting on. The BUTTON itself never
   * changes — Google's guidelines require the white surface — but the
   * consent note beneath it and the "last used" pill above it are our
   * own text, and the light-ground greys are unreadable on the navy
   * auth surface. Defaults to 'onLight'.
   */
  tone?: 'onLight' | 'onDark';
  /**
   * Geometry, so this button can sit in a stack without looking like a
   * different component. 'rounded' (14px) is the default and matches the
   * form controls on /signup/patient, where it sits above an email form.
   * 'pill' matches the fully-rounded stacks on /login and /signup.
   *
   * Google's guidelines constrain the button's SURFACE — white ground,
   * unmodified 4-colour glyph, approved wording — not its corner radius,
   * so varying this is within the rules.
   */
  shape?: 'pill' | 'rounded';
  /**
   * Whether the caller has collected an affirmative agreement to the
   * terms before this click.
   *
   *   undefined — the caller is not a consent moment. The button behaves
   *               exactly as it always did. /login passes nothing: it is
   *               a sign-in screen, so a brand-new account arriving that
   *               way carries no acceptance, and /auth/callback REFUSES
   *               the session and returns it to /signup to agree. (This
   *               used to say "caught by the terms step in onboarding".
   *               There is no such step, and describing a downstream
   *               screen as the backstop is part of why the refusal was
   *               allowed to be best-effort — see the field bug in
   *               lib/legal/acceptance.test.ts.)
   *   false     — blocked. The click does NOT start OAuth; onConsentMissing
   *               fires instead so the caller can point at its checkbox.
   *   true      — proceed, and carry the acceptance to /auth/callback so
   *               it can be recorded.
   *
   * The acceptance travels as a query parameter because the tick happens
   * BEFORE any session exists — there is no profile to stamp yet. That
   * makes the resulting record client-asserted, which is weaker than a
   * server action on an authenticated session. Only the person completing
   * the OAuth flow can set it, so the failure mode is someone asserting
   * their own agreement rather than forging another's. Anything arriving
   * unstamped is refused outright at /auth/callback, and refused again by
   * lib/legal/termsGate.ts on every surface a session can reach.
   */
  consentGiven?: boolean;
  /** Called instead of starting OAuth when consentGiven is false. */
  onConsentMissing?: () => void;
};

// Origin-relative allow-list. Same posture as /auth/callback safeNext
// so if the caller somehow hands us a tampered value, we still send
// the user to /dashboard rather than an off-domain redirect.
function safeNext(raw: string | undefined): string {
  const DEFAULT = '/dashboard';
  if (!raw) return DEFAULT;
  if (!raw.startsWith('/') || raw.startsWith('//')) return DEFAULT;
  return raw;
}

export default function ContinueWithGoogleButton({
  label = 'Continue with Google',
  ariaLabel,
  next,
  onSignInAttempt,
  highlighted,
  showConsentNote = true,
  tone = 'onLight',
  shape = 'rounded',
  consentGiven,
  onConsentMissing,
}: Props) {
  const onDark = tone === 'onDark';
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const blocked = consentGiven === false;

  async function handleClick() {
    // Deliberately NOT disabled — and not aria-disabled either.
    //
    // Both stop the click from ever landing, which sounds like the point
    // until you notice that the click is what DELIVERS THE EXPLANATION:
    // onConsentMissing is what surfaces the error and moves focus to the
    // checkbox. Blocking it leaves someone facing a control that does
    // nothing and says nothing about why — worst for exactly the people
    // an aria attribute was meant to help. (Caught by a browser test:
    // Playwright treats aria-disabled as non-interactive and refused the
    // click, which is the same refusal an assistive tech may make.)
    //
    // So the button stays fully interactive. The dimming is a hint; the
    // click is the explanation.
    if (blocked) {
      onConsentMissing?.();
      return;
    }
    setLoading(true);
    setError(null);
    onSignInAttempt?.();

    const supabase = createClient();
    const origin = typeof window !== 'undefined' ? window.location.origin : '';

    // redirectTo must be allowed in the Supabase dashboard's Auth →
    // URL Configuration → Redirect URLs list. `/auth/callback` is the
    // shared PKCE landing (see the password-reset build). The `next`
    // param is validated at BOTH ends — safeNext above blocks a
    // tampered caller here, and /auth/callback::safeNext blocks a
    // tampered Google-hosted round-trip. Belt-and-braces so no
    // single edit can open a redirect vector.
    const nextParam = safeNext(next);
    // terms_accepted rides along only when the caller actually collected
    // the tick. Absent by default, so no surface can accidentally claim
    // an agreement it never asked for.
    const consentParam = consentGiven ? '&terms_accepted=1' : '';
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(nextParam)}${consentParam}`,
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
      {highlighted && <LastUsedPill tone={tone} />}
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        aria-label={ariaLabel ?? label}
        data-testid="continue-with-google"
        // Contents are centred, but as a FIXED-WIDTH row (.auth-option-row
        // in app/globals.css) rather than shrink-to-fit — so the icon and
        // label land at the same coordinates here as in the sibling
        // options, instead of at coordinates derived from this button's
        // own label width. See that block for the measurements.
        className={`flex h-[52px] w-full items-center justify-center border-[1.5px] bg-white text-[15px] font-medium text-[#1F2937] hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors ${
          shape === 'pill' ? 'rounded-full' : 'rounded-[14px]'
        }`}
        style={{
          ...(highlighted
            ? { borderColor: '#15A89E', boxShadow: '0 0 0 3px rgba(21,168,158,.12)' }
            : { borderColor: '#E2E8EE' }),
          ...(blocked ? { opacity: 0.45 } : null),
        }}
      >
        <span className="auth-option-row">
          <GoogleGlyph />
          <span className="auth-option-label">{loading ? 'Opening Google…' : label}</span>
        </span>
      </button>
      {showConsentNote && (
        <p
          className={`mt-2 text-center text-[11px] leading-[1.5] ${onDark ? 'text-[var(--auth-dim)]' : 'text-[#5B6B80]'}`}
          data-testid="google-consent-note"
        >
          By continuing with Google you agree to betternow&apos;s{' '}
          <Link
            href="/legal/terms"
            target="_blank"
            rel="noopener"
            className={`font-semibold underline underline-offset-2 ${onDark ? 'text-white' : 'text-[#41556F]'}`}
          >
            Terms &amp; Conditions
          </Link>
          {' '}and{' '}
          <Link
            href="/legal/privacy"
            target="_blank"
            rel="noopener"
            className={`font-semibold underline underline-offset-2 ${onDark ? 'text-white' : 'text-[#41556F]'}`}
          >
            Privacy Policy
          </Link>.
        </p>
      )}
      {error && (
        <p className={`mt-2 text-xs ${onDark ? 'text-red-300' : 'text-red-700'}`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ─── Google "G" glyph (official 4-colour) ─────────────────────────────

function GoogleGlyph() {
  return (
    <svg className="shrink-0" width="18" height="18" viewBox="0 0 18 18" aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.264h2.909c1.702-1.567 2.683-3.874 2.683-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.909-2.258c-.806.54-1.837.86-3.047.86-2.344 0-4.328-1.584-5.036-3.71H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.712A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.712V4.956H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.044l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.956L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  );
}
