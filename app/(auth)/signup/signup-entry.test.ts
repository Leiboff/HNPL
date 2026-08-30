import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── /signup — the auth entry screen ───────────────────────────────────
//
// /signup used to be `redirect('/')`: a visitor who typed it, or
// followed a "sign up" link that predated /signup/patient, was dumped on
// the marketing page to hunt for a CTA. It now renders the entry screen
// — one mobile-first stack of every way in.
//
// Source-text pins, matching how every other test in this repo covers a
// heavy client page (see app/google-oauth.test.ts,
// app/(auth)/login/last-used-method.test.ts). The behaviour underneath
// each button is already covered where it lives: the Google OAuth call
// in app/google-oauth.test.ts, the passkey ceremony in
// lib/hooks/usePasskeySignIn's own tests, and the consent disclosure +
// server-side record in app/oauth-terms-consent.test.ts.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const codeOf = (p: string) => stripComments(read(p));

const PAGE  = codeOf('app/(auth)/signup/page.tsx');
const ENTRY = codeOf('app/(auth)/signup/SignupEntry.tsx');

describe('the route renders the screen instead of bouncing', () => {
  it('no longer redirects away', () => {
    expect(PAGE).not.toMatch(/redirect\(/);
    expect(PAGE).toMatch(/<SignupEntry \/>/);
  });

  it('stays a SYNCHRONOUS page — an async page would need a loading.tsx it has nothing to await for', () => {
    // app/loading-coverage.test.tsx walks every `export default async
    // function` page and requires a loading.tsx boundary above it.
    // This page awaits nothing, so it must not become async by accident.
    expect(PAGE).toMatch(/export default function SignupPage/);
    expect(PAGE).not.toMatch(/export default async function/);
  });
});

describe('every way in is present, and each hands off to the path that already existed', () => {
  it('email → /signup/patient (the form that carries the "I agree" tick)', () => {
    expect(ENTRY).toMatch(/href="\/signup\/patient"/);
    expect(ENTRY).toMatch(/data-testid="signup-entry-email"/);
    expect(ENTRY).toMatch(/Sign up with email/);
  });

  it('Google → the shared button, not a second signInWithOAuth call site', () => {
    expect(ENTRY).toMatch(/from '@\/app\/_components\/ContinueWithGoogleButton'/);
    expect(ENTRY).toMatch(/<ContinueWithGoogleButton/);
    // No hand-rolled OAuth here — one call site, in the button.
    expect(ENTRY).not.toMatch(/signInWithOAuth/);
  });

  it('every method on the screen can actually create an account', () => {
    // The whole point of the stack: this is a front door. Email creates
    // one; Google creates one on the same click that signs an existing
    // user in. Those are the only two, and they are both here.
    expect(ENTRY).toMatch(/data-testid="signup-entry-email"/);
    expect(ENTRY).toMatch(/<ContinueWithGoogleButton/);
  });
});

describe('there is deliberately NO passkey button', () => {
  // WHY THIS TEST EXISTS.
  //
  // A passkey cannot create an account. supabase.auth.registerPasskey()
  // needs a session, and the only two surfaces that call it
  // (PostLoginPasskeyPrompt, /patient/account/passkeys) sit behind auth
  // — so a passkey can only ever sign an EXISTING user back in.
  //
  // The trap is that usePasskeySignIn's `supported` flag means "this
  // browser does WebAuthn", NOT "this visitor has a passkey". A button
  // wired to it renders for every new visitor on a modern phone and
  // dead-ends all of them: the OS sheet opens with no credential for
  // this site, they dismiss it, user_cancelled maps to an empty
  // message, and the screen does nothing at all.
  //
  // This is easy to re-add in good faith ("/login has one, why not
  // here?"), so the absence is pinned rather than left to memory.

  it('does not import the passkey sign-in hook', () => {
    expect(ENTRY).not.toMatch(/usePasskeySignIn/);
    expect(ENTRY).not.toMatch(/passkeyErrorMessage/);
  });

  it('renders no passkey affordance', () => {
    expect(ENTRY).not.toMatch(/data-testid="signup-entry-passkey"/);
    expect(ENTRY).not.toMatch(/Sign in with a passkey/);
  });

  it('/login — where a passkey genuinely works — still has one', () => {
    // The capability is not being removed from the product, only from
    // the screen it cannot work on. If this ever fails, the passkey
    // path has been lost entirely rather than relocated.
    const LOGIN = codeOf('app/(auth)/login/page.tsx');
    expect(LOGIN).toMatch(/usePasskeySignIn/);
    expect(LOGIN).toMatch(/Sign in with a passkey/);
  });
});

describe('cross-links out', () => {
  it('existing accounts get a sign-in link', () => {
    expect(ENTRY).toMatch(/data-testid="signup-entry-login"/);
    expect(ENTRY).toMatch(/href="\/login"/);
  });

  it('practices get their own door — Google is a patient path only', () => {
    expect(ENTRY).toMatch(/data-testid="signup-entry-practice"/);
    expect(ENTRY).toMatch(/href="\/signup\/practice"/);
  });
});

describe('a signed-in visitor is not shown a front door', () => {
  it('reads the cached session on mount and forwards to the dispatcher', () => {
    // Same shortcut /login uses: getSession() reads the cookie the
    // browser client already holds — a convenience, never the boundary.
    expect(ENTRY).toMatch(/createClient\(\)\.auth\.getSession\(\)/);
    expect(ENTRY).toMatch(/if \(!cancelled && session\) window\.location\.href = '\/dashboard';/);
    // Cleanup so a fast unmount cannot navigate after the fact.
    expect(ENTRY).toMatch(/return \(\) => \{ cancelled = true; \};/);
  });
});

describe('brand', () => {
  it('uses the betternow wordmark and Poppins, not a generic heading', () => {
    expect(ENTRY).toMatch(/better<span/);
    expect(ENTRY).toMatch(/var\(--font-poppins\)/);
  });

  it('the decorative background can never intercept a tap on the buttons', () => {
    expect(ENTRY).toMatch(/aria-hidden className="pointer-events-none absolute inset-0/);
  });

  it('shows NO mocked-up amounts — nothing here can be mistaken for a quote', () => {
    // An earlier draft put an invented R3,000 split in the hero. A real
    // schedule comes from the patient's salary_day at checkout, and a
    // fake one on the front door is the single thing on this screen a
    // visitor could read as an offer. No rand figures at all.
    expect(ENTRY).not.toMatch(/R\s?\d/);
  });
});
