'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import ContinueWithGoogleButton from '@/app/_components/ContinueWithGoogleButton';
import AuthSurface from '@/app/_components/AuthSurface';
import AuthWordmark from '@/app/_components/AuthWordmark';
import PatientSignupForm from '@/app/signup/patient/PatientSignupForm';

// ─── /signup — the auth entry screen ───────────────────────────────────
//
// One mobile-first screen that opens the whole front door: brand, the
// promise in a sentence, then every way in as a stack of full-width
// pills. Previously /signup was a bare redirect('/'), so a visitor who
// typed it — or tapped a "sign up" link from an email — landed on the
// marketing page and had to hunt for the CTA.
//
// The stack is ordered by how most patients actually arrive:
//   1. Sign up with email  → the form view on THIS route (the full form
//      + I-agree tick). /signup/patient used to be a separate route for
//      it; that split is gone and the old URL now redirects here, so
//      there is one canonical "create an account" screen.
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
// the acceptance server-side when an OAuth user arrives — and refuses
// the session outright if the record doesn't land, signing the arrival
// back out and bouncing it to this screen with ?error= (see `bounce`
// below). There is no longer an onboarding step behind this: the tick
// is the only gate, so it has to hold.

const TEAL = '#15A89E';

// ── Bounced back from /auth/callback ──────────────────────────────────
//
// The callback refuses an OAuth session that has no acceptance recorded
// on the profile row — signs it out and sends the visitor here with
// ?error=. Without a line explaining it, that round trip looks like
// Google silently failing.
//
// useSyncExternalStore rather than an effect or useSearchParams. An
// effect that setStates on mount is a cascading render (and the lint
// rule that says so is right); useSearchParams would force a Suspense
// boundary around this whole screen and cost the page its prerender.
// This reads the URL during render on the client and returns null on the
// server, which is exactly the two-snapshot case the hook exists for —
// React hydrates the server value and swaps to the client one itself.
//
// The subscribe is a no-op: nothing here navigates without a full page
// load, so the value cannot change while mounted.
const NEVER_CHANGES = () => () => {};

function useBounce(): 'terms' | 'terms_write' | null {
  const raw = useSyncExternalStore(
    NEVER_CHANGES,
    () => new URLSearchParams(window.location.search).get('error'),
    () => null,
  );
  return raw === 'terms' || raw === 'terms_write' ? raw : null;
}

export default function SignupEntry() {
  // ── Two views, one route ────────────────────────────────────────────
  //
  // false → the method chooser (email / Google).
  // true  → the email signup form, which REPLACES the chooser rather
  //         than expanding below it.
  //
  // Deliberately the same machinery as /login: pushState on open so the
  // device back button returns to the chooser instead of leaving
  // /signup, popstate to close, and the on-screen arrow delegating to
  // history.back() so the two cannot diverge. The two journeys are now
  // mirror images of each other, which is the point.
  // ── One tick, both routes ───────────────────────────────────────────
  //
  // Sits under BOTH options rather than inside the email form, because
  // the Google path had no equivalent moment: OAuth leaves the page and
  // comes back with an account already made. Collecting it here — before
  // either route starts — is the only point both paths pass through.
  //
  // NOT pre-checked, deliberately. A pre-ticked box is the textbook
  // example of consent that is not freely given (POPIA's "expression of
  // will"; GDPR's "clear affirmative action"), and functionally it is
  // the same as the passive "by continuing you agree" line this
  // replaces — the visitor does nothing. Unchecked costs one tap on a
  // screen they are already looking at.
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsError,    setTermsError]    = useState(false);

  const bounce = useBounce();

  function requireTerms(): boolean {
    if (termsAccepted) return true;
    setTermsError(true);
    document.getElementById('signup-termsAccepted')?.focus();
    return false;
  }

  const [formOpen, setFormOpen] = useState(false);
  const [viewDir,  setViewDir]  = useState<'forward' | 'back'>('forward');

  function openForm() {
    if (!requireTerms()) return;
    setViewDir('forward');
    setFormOpen(true);
    try { window.history.pushState({ hnplSignupView: 'form' }, ''); } catch { /* non-fatal: the arrow still works */ }
  }

  function closeForm() {
    if (window.history.state?.hnplSignupView === 'form') { window.history.back(); return; }
    setViewDir('back');
    setFormOpen(false);
  }

  useEffect(() => {
    function onPop() {
      setViewDir('back');
      setFormOpen(false);
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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
    // Not `centred`: the form view is tall enough to scroll on a small
    // phone, and centring a scrolling column pushes its first line off
    // the top. The chooser keeps its own vertical centring below.
    <AuthSurface>
      {!formOpen ? (
        <div key="chooser" className={`auth-view-${viewDir} flex min-h-[calc(100vh-6rem)] flex-col justify-center`} data-testid="signup-view-chooser">
        {/* ── Hero: the wordmark carries it ─────────────────────────
            There is no illustration here on purpose. A mocked-up bill
            with invented figures is the one thing on this screen a
            visitor could mistake for a quote, and it bought nothing the
            headline doesn't already say. The brand, the promise, and
            the way in — nothing between them. */}
        <AuthWordmark size="lg" href={null} />

        {/* ── The promise ───────────────────────────────────────────── */}
        <h1 className="mt-10 text-center text-[31px] font-semibold leading-[1.2] tracking-[-0.03em] text-white">
          Any medical bill,
          <br />
          split interest-free
        </h1>
        <p className="mt-4 text-center text-[15px] leading-[1.55] text-[var(--auth-muted)]">
          Pay in 2 or 3 instalments, timed around your payday. No interest, ever.
        </p>

        {/* ── Why you're back here ──────────────────────────────────── */}
        {bounce && (
          <div
            role="alert"
            data-testid="signup-bounce-notice"
            // Same red as the tick's own error below, not a new colour.
            // It is the same problem stated one step earlier, and the
            // eye should read them as one thing.
            className="mt-8 rounded-2xl border-[1.5px] border-red-400/70 bg-red-500/10 p-4 text-[14px] leading-[1.6] text-red-100"
          >
            {bounce === 'terms'
              ? 'Almost there — we can’t create your account until you’ve agreed to the terms below. Tick the box, then continue with Google again.'
              : 'Something went wrong recording your agreement to the terms, so your account wasn’t created. Please tick the box and try again.'}
          </div>
        )}

        {/* ── The ways in ───────────────────────────────────────────── */}
        <div className="mt-9 space-y-3" data-testid="signup-entry-methods">
          <button
            type="button"
            onClick={openForm}
            data-testid="signup-entry-email"
            className="flex h-[52px] w-full items-center justify-center rounded-full text-[15px] font-semibold text-[var(--auth-on-teal)] transition-transform active:scale-[.985]"
            // Dimmed while the tick is missing, matching the Google
            // button beside it — both routes are gated, so both must read
            // as equally unavailable. Still clickable: the click is what
            // explains why (see requireTerms).
            style={{
              background: TEAL,
              boxShadow: termsAccepted ? '0 14px 30px -12px rgba(21,168,158,.75)' : 'none',
              opacity: termsAccepted ? 1 : 0.45,
            }}
          >
            {/* Carries the envelope for the same reason /login's email
                option does: without an icon its label would start at the
                icon column while its neighbour's starts after the gap,
                and the stack would be misaligned again by omission. */}
            <span className="auth-option-row">
              <svg className="h-[18px] w-[18px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="m3 7 9 6 9-6" />
              </svg>
              <span className="auth-option-label">Sign up with email</span>
            </span>
          </button>

          <ContinueWithGoogleButton
            label="Continue with Google"
            shape="pill"
            showConsentNote={false}
            consentGiven={termsAccepted}
            onConsentMissing={requireTerms}
          />
        </div>

        {/* ── The agreement, for both routes above ─────────────────── */}
        <div className="mt-6">
          <div className={`flex items-start gap-[13px] rounded-2xl border-[1.5px] p-4 transition-colors ${
            termsError
              ? 'border-red-400/70 bg-red-500/10'
              : 'border-[var(--auth-edge)] bg-[var(--auth-fill-raised)]'
          }`}>
            <input
              id="signup-termsAccepted"
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => { setTermsAccepted(e.target.checked); setTermsError(false); }}
              data-testid="signup-terms-checkbox"
              className="mt-px h-5 w-5 shrink-0 rounded-md border-[1.5px] border-[var(--auth-edge)] accent-[#15A89E]"
            />
            <label htmlFor="signup-termsAccepted" className="text-[14px] leading-[1.6] text-[var(--auth-muted)]">
              I agree to betternow&apos;s{' '}
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
            </label>
          </div>
          {termsError && (
            <p className="mt-2 text-[13px] text-red-300" role="alert" data-testid="signup-terms-error">
              Please accept the betternow terms to continue.
            </p>
          )}
        </div>

        {/* ── Existing account ────────────────────────────────────────
            This is the ONLY route back for a returning user, passkey
            users included — /login runs the conditional-UI ceremony, so
            a saved passkey appears as an autofill suggestion there. */}
        <p className="mt-8 text-center text-[15px] text-[var(--auth-muted)]">
          Already have an account?{' '}
          <Link
            href="/login"
            data-testid="signup-entry-login"
            className="font-semibold"
            style={{ color: 'var(--auth-accent)' }}
          >
            Sign in
          </Link>
        </p>

        {/* Practices are invite-provisioned staff accounts, not a Google
            path — kept as a quiet third door rather than a fourth pill,
            so the patient stack stays the obvious read. */}
        <p className="mt-3 text-center text-[13px] text-[var(--auth-dim)]">
          Are you a practice?{' '}
          <Link
            href="/signup/practice"
            data-testid="signup-entry-practice"
            className="font-medium underline underline-offset-[3px] text-[var(--auth-muted)]"
          >
            Register your practice
          </Link>
        </p>
        </div>
      ) : (
        /* ─── The form: same screen-swap as /login's email view ─────── */
        <div key="form" className={`auth-view-${viewDir}`} data-testid="signup-view-form">
          <AuthWordmark size="lg" href={null} />

          <button
            type="button"
            onClick={closeForm}
            data-testid="signup-form-back"
            className="mt-8 -ml-2 flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[14px] font-medium text-[var(--auth-muted)] transition-colors hover:text-white"
          >
            <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 18-6-6 6-6" />
            </svg>
            Back
          </button>

          <h1 className="mt-4 text-[28px] font-semibold leading-[1.2] tracking-[-0.03em] text-white">
            Create your account
          </h1>
          <p className="mt-2 mb-7 text-[15px] text-[var(--auth-muted)]">
            Interest-free medical payment plans.
          </p>

          <PatientSignupForm invitation={null} token={null} termsAccepted={termsAccepted} />
        </div>
      )}
    </AuthSurface>
  );
}
