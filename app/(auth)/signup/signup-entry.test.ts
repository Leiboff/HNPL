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

const PAGE    = codeOf('app/(auth)/signup/page.tsx');
const ENTRY   = codeOf('app/(auth)/signup/SignupEntry.tsx');
const SURFACE = codeOf('app/_components/AuthSurface.tsx');

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
  it('email → the form view on this same route, not another page', () => {
    // WAS a link to /signup/patient. That route is retired (it now
    // redirects here), so this is an in-page view switch — the same
    // screen-swap /login uses for its email screen.
    expect(ENTRY).toMatch(/data-testid="signup-entry-email"/);
    expect(ENTRY).toMatch(/onClick=\{openForm\}/);
    expect(ENTRY).toMatch(/Sign up with email/);
    expect(ENTRY).not.toMatch(/href="\/signup\/patient"/);
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
  it('uses the betternow wordmark, not a generic heading', () => {
    expect(ENTRY).toMatch(/better<span/);
  });

  it('sits on the shared auth surface rather than its own copy of the gradient', () => {
    // The navy ground + blobs were pasted into three files before this
    // was extracted. Pin that the entry screen consumes the shared one,
    // and that it has not re-grown a local copy.
    expect(ENTRY).toMatch(/from '@\/app\/_components\/AuthSurface'/);
    expect(ENTRY).toMatch(/<AuthSurface>/);
    expect(ENTRY).not.toMatch(/linear-gradient\(180deg/);
  });

  it('the decorative background can never intercept a tap on the buttons', () => {
    expect(SURFACE).toMatch(/aria-hidden className="pointer-events-none absolute inset-0/);
  });

  it('the surface carries Poppins for every screen that uses it', () => {
    expect(SURFACE).toMatch(/var\(--font-poppins\)/);
  });

  it('shows NO mocked-up amounts — nothing here can be mistaken for a quote', () => {
    // An earlier draft put an invented R3,000 split in the hero. A real
    // schedule comes from the patient's salary_day at checkout, and a
    // fake one on the front door is the single thing on this screen a
    // visitor could read as an offer. No rand figures at all.
    expect(ENTRY).not.toMatch(/R\s?\d/);
  });
});

describe('the signup form is a view here, not a route of its own', () => {
  // /signup was a chooser and /signup/patient was the form: two routes
  // for one job, and the second was still the old white-card design
  // while the first had been rebuilt. The form is now the second view of
  // THIS route, mirroring /login exactly, and the old route redirects.

  const ROUTE = codeOf('app/signup/patient/page.tsx');
  const FORM  = codeOf('app/signup/patient/PatientSignupForm.tsx');

  it('renders exactly one of the two views, never both', () => {
    expect(ENTRY).toMatch(/\{!formOpen \? \(/);
    expect(ENTRY).toMatch(/data-testid="signup-view-chooser"/);
    expect(ENTRY).toMatch(/data-testid="signup-view-form"/);
    expect(ENTRY).not.toMatch(/\{formOpen && \(/);
  });

  it('the form view carries a way back, like /login\'s email screen', () => {
    const form = ENTRY.slice(ENTRY.indexOf('data-testid="signup-view-form"'));
    expect(form).toMatch(/data-testid="signup-form-back"/);
    expect(form).toMatch(/onClick=\{closeForm\}/);
    expect(form).toMatch(/<PatientSignupForm/);
  });

  it('looking like a page means behaving like one, same as /login', () => {
    // Without the history entry, hardware-back from the form leaves
    // /signup entirely — and this form is long enough that losing it
    // by accident is expensive.
    expect(ENTRY).toMatch(/window\.history\.pushState\(\{ hnplSignupView: 'form' \}, ''\)/);
    expect(ENTRY).toMatch(/window\.addEventListener\('popstate', onPop\)/);
    expect(ENTRY).toMatch(/window\.history\.back\(\); return;/);
  });

  it('the retired route redirects rather than 404s', () => {
    expect(ROUTE).toMatch(/redirect\('\/signup'\)/);
    // …and still honours the invite-token branch, which predates this.
    expect(ROUTE).toMatch(/redirect\(`\/checkout\/\$\{encodeURIComponent\(token\)\}`\)/);
  });

  it('the form is dressed for the dark surface it now sits on', () => {
    // It kept a white card's colours when the page around it went navy;
    // near-black text on navy is invisible but still focusable.
    expect(FORM).toMatch(/text-white/);
    expect(FORM).not.toMatch(/text-\[#13294B\]/);
    expect(FORM).not.toMatch(/bg-\[#FBFCFD\]/);
    expect(FORM).not.toMatch(/text-gray-500|text-gray-600/);
    // Same field geometry as the sign-in email screen.
    expect(FORM).toMatch(/h-\[52px\] w-full rounded-2xl/);
  });

  it('nothing in the app still links to the retired route', () => {
    for (const p of [
      'app/LandingPage.tsx',
      'app/_landing/SiteHeader.tsx',
      'app/_landing/SiteFooter.tsx',
      'app/(auth)/login/page.tsx',
      'app/auth/confirmed/ConfirmedView.tsx',
      'app/verify-email/page.tsx',
      'app/(auth)/verify-phone/page.tsx',
    ]) {
      expect(codeOf(p)).not.toMatch(/["\'`]\/signup\/patient/);
    }
  });
});

describe('a refused OAuth arrival is told why it is back here', () => {
  // /auth/callback signs out an OAuth arrival with no acceptance on
  // record and returns it to /signup with ?error=. Silence there would
  // read as Google having failed — the visitor would tap the same button
  // again and get the same nothing.

  it('renders a notice for both refusal reasons, and only those', () => {
    expect(ENTRY).toMatch(/data-testid="signup-bounce-notice"/);
    expect(ENTRY).toMatch(/raw === 'terms' \|\| raw === 'terms_write' \? raw : null/);
    // role=alert, because it appears after the screen has already
    // rendered once — a returning visitor is not re-reading the page.
    expect(ENTRY).toMatch(/role="alert"[\s\S]{0,80}data-testid="signup-bounce-notice"/);
  });

  it('the two reasons say different things', () => {
    // "you haven't agreed yet" and "we couldn't save your agreement" are
    // different problems; telling someone to tick a box they already
    // ticked is how a bug becomes a loop.
    expect(ENTRY).toMatch(/bounce === 'terms'/);
    expect(ENTRY).toMatch(/agreed to the terms below/);
    expect(ENTRY).toMatch(/went wrong recording your agreement/);
  });

  it('reads the URL without an effect and without Suspense', () => {
    // A setState-on-mount effect is a cascading render; useSearchParams
    // would force a Suspense boundary around the whole screen and cost
    // the page its prerender. useSyncExternalStore is the two-snapshot
    // case this hook exists for.
    expect(ENTRY).toMatch(/useSyncExternalStore\(/);
    expect(ENTRY).not.toMatch(/useSearchParams/);
  });
});

