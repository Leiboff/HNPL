'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import ContinueWithGoogleButton from '@/app/_components/ContinueWithGoogleButton';
import AuthSurface from '@/app/_components/AuthSurface';

// ─── /signup — the auth entry screen ───────────────────────────────────
//
// One mobile-first screen that opens the whole front door: brand, the
// promise in a sentence, then every way in as a stack of full-width
// pills. Previously /signup was a bare redirect('/'), so a visitor who
// typed it — or tapped a "sign up" link from an email — landed on the
// marketing page and had to hunt for the CTA.
//
// The stack is ordered by how most patients actually arrive:
//   1. Sign up with email  → /signup/patient (the full form + I-agree tick)
//   2. Continue with Google → OAuth, patients only (same button as /login)
//
// Nothing here is a new auth mechanism: each button hands off to the
// path that already existed. This screen is presentation + routing.
//
// ─── Why there is NO passkey button here ──────────────────────────────
//
// There is no such thing as signing UP with a passkey in this system.
// A passkey is enrolled against an account that already exists —
// supabase.auth.registerPasskey() needs a session, and the only two
// surfaces that call it (PostLoginPasskeyPrompt, /patient/account/
// passkeys) are both behind auth. So a passkey can only ever sign an
// EXISTING user back in.
//
// usePasskeySignIn gates on `supported`, which means "this browser does
// WebAuthn" — not "this visitor has a passkey". A passkey button here
// would therefore render for every new visitor on a modern phone and
// dead-end every one of them: the OS sheet opens with no credential for
// this site, they dismiss it, and user_cancelled maps to an empty
// message, so the screen does nothing at all. The one button on the
// front door that cannot work for the people the front door is for.
//
// Returning passkey users are better served by /login anyway, which is
// one tap away below: it runs the conditional-UI ceremony, so their
// passkey surfaces as an autofill suggestion on the email field with no
// button press at all, and LastUsedPill highlights it if it is what
// they used last.
//
// Google is a genuine exception and stays: OAuth signs a new user UP
// and an existing user IN with the same click, which is why its label
// reads "Continue with".
//
// ─── Consent ──────────────────────────────────────────────────────────
//
// One legal line sits beneath the whole stack, so it covers the Google
// button (which has no "I agree" tick of its own) as well as the email
// route. ContinueWithGoogleButton renders its own
// note by default; here it is suppressed because this line already
// says the same thing for every button above it. /auth/callback records
// the acceptance server-side when an OAuth user arrives.

const TEAL = '#15A89E';

export default function SignupEntry() {
  // Already signed in? Don't show a front door to someone who is
  // already inside. Mirrors /login's shortcut: getSession() reads the
  // cookie the browser client already holds (no round trip) and is a
  // convenience, never the security boundary — /dashboard re-checks.
  useEffect(() => {
    let cancelled = false;
    createClient().auth.getSession().then(({ data: { session } }) => {
      if (!cancelled && session) window.location.href = '/dashboard';
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <AuthSurface centred>
        {/* ── Hero: the wordmark carries it ─────────────────────────
            There is no illustration here on purpose. A mocked-up bill
            with invented figures is the one thing on this screen a
            visitor could mistake for a quote, and it bought nothing the
            headline doesn't already say. The brand, the promise, and
            the way in — nothing between them. */}
        <div className="text-center">
          <span className="text-[46px] font-bold leading-none tracking-[-0.04em] text-white">
            better<span style={{ color: '#4FD8CD' }}>now</span>
          </span>
        </div>

        {/* ── The promise ───────────────────────────────────────────── */}
        <h1 className="mt-10 text-center text-[31px] font-semibold leading-[1.2] tracking-[-0.03em] text-white">
          Any medical bill,
          <br />
          split interest-free
        </h1>
        <p className="mt-4 text-center text-[15px] leading-[1.55] text-[#9FB3CC]">
          Pay in 2 or 3 instalments, timed around your payday. No interest, ever.
        </p>

        {/* ── The ways in ───────────────────────────────────────────── */}
        <div className="mt-9 space-y-3" data-testid="signup-entry-methods">
          <Link
            href="/signup/patient"
            data-testid="signup-entry-email"
            className="flex h-[54px] w-full items-center justify-center rounded-full text-[16px] font-semibold text-[#06202B] transition-transform active:scale-[.985]"
            style={{ background: TEAL, boxShadow: '0 14px 30px -12px rgba(21,168,158,.75)' }}
          >
            Sign up with email
          </Link>

          <ContinueWithGoogleButton
            label="Continue with Google"
            showConsentNote={false}
          />
        </div>

        {/* ── One legal line for the whole stack ────────────────────── */}
        <p
          data-testid="signup-entry-consent"
          className="mt-5 text-center text-[12px] leading-[1.6] text-[#8AA0BC]"
        >
          By continuing you agree to our{' '}
          <Link
            href="/legal/terms"
            target="_blank"
            rel="noopener"
            className="font-semibold text-white underline underline-offset-[3px]"
          >
            Terms &amp; Conditions
          </Link>
          {' '}and{' '}
          <Link
            href="/legal/privacy"
            target="_blank"
            rel="noopener"
            className="font-semibold text-white underline underline-offset-[3px]"
          >
            Privacy Policy
          </Link>.
        </p>

        {/* ── Existing account ────────────────────────────────────────
            This is the ONLY route back for a returning user, passkey
            users included — /login runs the conditional-UI ceremony, so
            a saved passkey appears as an autofill suggestion there. */}
        <p className="mt-8 text-center text-[15px] text-[#9FB3CC]">
          Already have an account?{' '}
          <Link
            href="/login"
            data-testid="signup-entry-login"
            className="font-semibold"
            style={{ color: '#4FD8CD' }}
          >
            Sign in
          </Link>
        </p>

        {/* Practices are invite-provisioned staff accounts, not a Google
            path — kept as a quiet third door rather than a fourth pill,
            so the patient stack stays the obvious read. */}
        <p className="mt-3 text-center text-[13px] text-[#7A90AD]">
          Are you a practice?{' '}
          <Link
            href="/signup/practice"
            data-testid="signup-entry-practice"
            className="font-medium underline underline-offset-[3px] text-[#A9BDD6]"
          >
            Register your practice
          </Link>
        </p>
    </AuthSurface>
  );
}
