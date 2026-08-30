import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── /login on the shared auth surface ─────────────────────────────────
//
// /login used to be a white card floating on the navy ground — it had
// the wallpaper of the /signup entry screen but none of its language.
// It now shares the surface itself, the pill buttons, and the dark form
// fields, so the three auth screens read as one flow.
//
// This file pins the things a RESTYLE can quietly break. The behavioural
// pins (?next= handling, the session shortcut, last-used recording,
// resend, the audience cue) already live in their own suites and all
// still apply — nothing here duplicates them.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const codeOf = (p: string) => stripComments(read(p));

const LOGIN   = codeOf('app/(auth)/login/page.tsx');
const SURFACE = codeOf('app/_components/AuthSurface.tsx');
const PILL    = codeOf('app/_components/LastUsedPill.tsx');
const GOOGLE  = codeOf('app/_components/ContinueWithGoogleButton.tsx');

describe('one surface, not three copies of a gradient', () => {
  it('all three auth screens consume AuthSurface', () => {
    for (const p of [
      'app/(auth)/login/page.tsx',
      'app/(auth)/signup/SignupEntry.tsx',
      'app/signup/patient/page.tsx',
    ]) {
      expect(codeOf(p)).toMatch(/from '@\/app\/_components\/AuthSurface'/);
      expect(codeOf(p)).toMatch(/<AuthSurface/);
    }
  });

  it('none of them still carries an inline copy of the navy gradient', () => {
    // This is the regression the extraction exists to prevent: the
    // string was in three files and had already been edited in one.
    for (const p of [
      'app/(auth)/login/page.tsx',
      'app/(auth)/signup/SignupEntry.tsx',
      'app/signup/patient/page.tsx',
    ]) {
      expect(codeOf(p)).not.toMatch(/linear-gradient\(180deg, #0A182E/);
    }
    expect(SURFACE).toMatch(/linear-gradient\(180deg, #0A182E/);
  });

  it('the surface is server-safe, so the server-rendered signup page can use it', () => {
    // A 'use client' here would force app/signup/patient/page.tsx —
    // which awaits searchParams — to become a client component.
    expect(SURFACE).not.toMatch(/'use client'/);
    expect(SURFACE).not.toMatch(/useState|useEffect/);
  });

  it('only /signup centres its column — the taller screens do not', () => {
    // Centring a column that scrolls pushes its first line off the top.
    expect(codeOf('app/(auth)/signup/SignupEntry.tsx')).toMatch(/<AuthSurface centred>/);
    expect(LOGIN).toMatch(/<AuthSurface>/);
    expect(codeOf('app/signup/patient/page.tsx')).toMatch(/<AuthSurface>/);
  });
});

describe('the dark ground did not swallow any text', () => {
  it('both inputs are styled for the dark surface, not left on light defaults', () => {
    // Two inputs, both with white text and a translucent fill. A missed
    // one renders near-black text on navy — invisible but still
    // focusable, which is the nastiest version of this bug.
    const darkInputs = LOGIN.match(/text-white outline-none transition-all placeholder:text-white\/35/g) ?? [];
    expect(darkInputs).toHaveLength(2);
    expect(LOGIN).not.toMatch(/text-gray-900/);
    expect(LOGIN).not.toMatch(/placeholder-gray-400/);
  });

  it('the Google button and the "last used" pill are told which ground they are on', () => {
    // Both render OUR text (consent note, pill) whose light-ground
    // greys are unreadable on navy. The button surface itself stays
    // white — Google's guidelines require it.
    expect(LOGIN).toMatch(/tone="onDark"/);
    expect(GOOGLE).toMatch(/tone\?: 'onLight' \| 'onDark'/);
    expect(PILL).toMatch(/tone === 'onDark' \? '#4FD8CD' : '#0C8579'/);
  });

  it('no light-card leftovers survive on the page', () => {
    expect(LOGIN).not.toMatch(/bg-white rounded-2xl/);
    expect(LOGIN).not.toMatch(/text-gray-500|text-gray-700|border-gray-200|border-gray-300/);
  });
});

describe('the passkey option — the reason /login differs from /signup', () => {
  it('is present here, where every visitor already has an account', () => {
    expect(LOGIN).toMatch(/passkeySupport\s*&&/);
    expect(LOGIN).toMatch(/Sign in with a passkey/);
  });

  it('the conditional-UI ceremony waits for the email input to exist', () => {
    // THE COUPLING THIS FILE EXISTS FOR.
    //
    // startAuthentication({ useBrowserAutofill: true }) binds to an input
    // with autocomplete="username webauthn". The email field now lives
    // behind a reveal, so on mount there is no such input — starting the
    // ceremony then would bind to nothing and the passkey suggestion
    // would silently never appear. Nothing would throw; the feature would
    // just quietly stop existing, which is why it is pinned rather than
    // trusted to reading.
    //
    // usePasskeySignIn takes conditionalWhen for exactly this, and /login
    // passes the reveal flag to it.
    const HOOK = codeOf('lib/hooks/usePasskeySignIn.ts');
    expect(LOGIN).toMatch(/conditionalWhen: emailOpen/);
    expect(HOOK).toMatch(/conditionalWhen = true/);
    expect(HOOK).toMatch(/if \(!supported \|\| !conditionalWhen\) return;/);
    // …and the ceremony effect must re-run when the flag flips, or the
    // deferral becomes a permanent disable.
    expect(HOOK).toMatch(/\}, \[supported, conditionalWhen\]\);/);
    expect(LOGIN).toMatch(/autoComplete="username webauthn"/);
  });

  it('feature detection is NOT deferred — the passkey button appears regardless', () => {
    // Gating `supported` on the same flag would hide the explicit passkey
    // button until someone opened the email form: the exact opposite of
    // what this screen wants, and an easy thing to do while "simplifying"
    // the hook back into one effect.
    const HOOK = codeOf('lib/hooks/usePasskeySignIn.ts');
    const detect = HOOK.slice(0, HOOK.indexOf('if (!supported || !conditionalWhen) return;'));
    expect(detect).toMatch(/if \(hasWebAuthn\) setSupported\(true\);/);
    expect(detect).toMatch(/\}, \[\]\);/);
  });
});

describe('email sign-in is a SCREEN, not an expanding panel', () => {
  // The two views are mutually exclusive on one route: entering the
  // email screen must take the chooser, the signup CTAs and the install
  // callout away with it, or the change reads as the page growing rather
  // than as arriving somewhere. That exclusivity is the whole effect, so
  // it is pinned rather than left to the eye.

  it('renders exactly one of the two views, never both', () => {
    expect(LOGIN).toMatch(/\{!emailOpen \? \(/);
    expect(LOGIN).toMatch(/data-testid="login-view-chooser"/);
    expect(LOGIN).toMatch(/data-testid="login-view-email"/);
    // A ternary, not two independent && blocks that could both render.
    expect(LOGIN).not.toMatch(/\{emailOpen && \(/);
  });

  it('the chooser owns the signup CTAs and the install callout', () => {
    // If these drift outside the ternary they persist onto the email
    // screen, and the illusion goes with them.
    const chooser = LOGIN.slice(
      LOGIN.indexOf('data-testid="login-view-chooser"'),
      LOGIN.indexOf('data-testid="login-view-email"'),
    );
    expect(chooser).toMatch(/aria-label="New to BetterNow"/);
    expect(chooser).toMatch(/<InstallCallout \/>/);
    expect(LOGIN.match(/<InstallCallout \/>/g) ?? []).toHaveLength(1);
  });

  it('the email screen has its own heading and a way back', () => {
    const emailView = LOGIN.slice(LOGIN.indexOf('data-testid="login-view-email"'));
    expect(emailView).toMatch(/data-testid="login-email-back"/);
    expect(emailView).toMatch(/onClick=\{closeEmail\}/);
    expect(emailView).toMatch(/Sign in with email/);
    expect(emailView).toMatch(/autoFocus/);
  });

  it('is the chooser on first load — nothing auto-navigates to the sub-screen', () => {
    expect(LOGIN).toMatch(/const \[emailOpen, setEmailOpen\] = useState\(false\);/);
    // The old auto-open was fine for an expanding panel and wrong for a
    // screen: it lands you on a page you never appeared to travel to.
    expect(LOGIN).not.toMatch(/setEmailOpen\(true\);?\s*\}?\s*,?\s*\[\]\)/);
    expect(LOGIN).not.toMatch(/if \(method === 'password'\) setEmailOpen\(true\)/);
  });

  it('the last-used password highlight moved to the chooser button', () => {
    // What replaces the auto-open: their usual way in is ringed and
    // pilled on the chooser, one tap away.
    const chooser = LOGIN.slice(
      LOGIN.indexOf('data-testid="login-view-chooser"'),
      LOGIN.indexOf('data-testid="login-view-email"'),
    );
    expect(chooser).toMatch(/data-testid="login-open-email"/);
    expect(chooser).toMatch(/lastUsed === 'password' && <LastUsedPill tone="onDark" \/>/);
    expect(chooser).toMatch(/lastUsed === 'password' \? \{ border: '1\.5px solid #15A89E'/);
  });
});

describe('looking like a page means behaving like one', () => {
  it('opening pushes a history entry, so the device back button comes back here', () => {
    // Without this, hardware-back from the email screen leaves /login
    // entirely — the single most jarring way a fake page can betray
    // itself, and the one users hit constantly in an installed PWA.
    expect(LOGIN).toMatch(/window\.history\.pushState\(\{ hnplLoginView: 'email' \}, ''\)/);
    expect(LOGIN).toMatch(/window\.addEventListener\('popstate', onPop\)/);
    expect(LOGIN).toMatch(/window\.removeEventListener\('popstate', onPop\)/);
  });

  it('the on-screen arrow and the hardware button run the SAME path', () => {
    // closeEmail delegates to history.back() so the two cannot diverge —
    // otherwise the arrow closes the view while leaving the pushed entry
    // behind, and the next hardware-back does nothing visible.
    expect(LOGIN).toMatch(/window\.history\.back\(\); return;/);
  });

  it('a pushState failure still leaves the arrow working', () => {
    // Sandboxed/file-origin contexts can throw on pushState. The view
    // must still open; only the hardware-back nicety is lost, which is
    // why closeEmail checks the state before delegating.
    expect(LOGIN).toMatch(/try \{ window\.history\.pushState/);
    expect(LOGIN).toMatch(/if \(window\.history\.state\?\.hnplLoginView === 'email'\)/);
  });

  it('the transition is directional and respects reduced motion', () => {
    const CSS = read('app/globals.css');
    expect(LOGIN).toMatch(/auth-view-\$\{viewDir\}/);
    expect(CSS).toMatch(/\.auth-view-forward/);
    expect(CSS).toMatch(/\.auth-view-back/);
    const reduced = CSS.slice(CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/auth-view-forward/);
    expect(reduced).toMatch(/animation: none/);
  });
});
