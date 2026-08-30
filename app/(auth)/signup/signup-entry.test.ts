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

  it('passkey → the shared hook, rendered only where WebAuthn is supported', () => {
    expect(ENTRY).toMatch(/from '@\/lib\/hooks\/usePasskeySignIn'/);
    expect(ENTRY).toMatch(/\{passkeySupport && \(/);
    expect(ENTRY).toMatch(/data-testid="signup-entry-passkey"/);
  });

  it('a passkey success records the method and bumps login_count before navigating', () => {
    // Same two side effects /login performs, so arriving via this screen
    // does not desync the "last used" hint or the passkey-prompt capping.
    const cbIdx = ENTRY.indexOf('const onPasskeySuccess');
    expect(cbIdx).toBeGreaterThan(-1);
    expect(ENTRY.indexOf("setLastSignInMethod('passkey')", cbIdx)).toBeGreaterThan(cbIdx);
    expect(ENTRY.indexOf('recordLoginLanding()', cbIdx)).toBeGreaterThan(cbIdx);
    expect(ENTRY.indexOf("window.location.href = '/dashboard'", cbIdx)).toBeGreaterThan(cbIdx);
  });

  it('a failed login_count bump never strands the sign-in', () => {
    // .finally() carries the redirect, so the catch cannot swallow it.
    expect(ENTRY).toMatch(/recordLoginLanding\(\)[\s\S]{0,200}\.finally\(\(\) => \{ window\.location\.href = '\/dashboard'; \}\)/);
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

  it('the hero figures are labelled in the source as illustrative, not a quote', () => {
    // The R3,000 split mirrors the landing page's example. A reader of
    // this file must not mistake it for a real schedule — the real one
    // comes from the patient's salary_day at checkout.
    expect(read('app/(auth)/signup/SignupEntry.tsx')).toMatch(/EXAMPLE, not a quote/);
  });
});
