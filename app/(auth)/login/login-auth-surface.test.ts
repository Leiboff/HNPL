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
      expect(codeOf(p)).not.toMatch(/linear-gradient\(180deg/);
    }
    expect(SURFACE).toMatch(/linear-gradient\(180deg, var\(--auth-ground-from\)/);
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
    expect(PILL).toMatch(/tone === 'onDark' \? '#19C2B6' : '#0C8579'/);
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
    expect(chooser).toMatch(/data-testid="login-signup-patient"/);
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

describe('the auth palette is the BRAND palette', () => {
  // WHY THIS EXISTS.
  //
  // These three screens are the app's only dark surfaces, and the brand
  // palette in app/landing.css was drawn for a light ground — it has no
  // muted text ramp that works on navy. Inventing one inline is how a
  // parallel palette gets born: at one point these files carried fifteen
  // hexes that appeared NOWHERE else in the app, two of which duplicated
  // brand tokens that already existed and one of which failed WCAG AA.
  //
  // The ramp now lives in one .auth-surface block and is derived only
  // from brand values. These tests are the fence around that.

  const CSS = read('app/globals.css');
  const AUTH = CSS.slice(CSS.indexOf('.auth-surface {'));
  const LANDING = read('app/landing.css');

  it('the screens carry no raw hex except the brand teal and white', () => {
    for (const p of ['app/(auth)/login/page.tsx', 'app/(auth)/signup/SignupEntry.tsx']) {
      const hexes = new Set(codeOf(p).match(/#[0-9A-Fa-f]{6}/g) ?? []);
      for (const h of hexes) {
        expect(['#15A89E', '#FFFFFF']).toContain(h.toUpperCase());
      }
    }
  });

  it('every hex in the token block is a colour the brand already defines', () => {
    const brand = new Set(
      (LANDING.match(/#[0-9A-Fa-f]{6}/g) ?? []).map((h) => h.toUpperCase()),
    );
    const used = (AUTH.match(/#[0-9A-Fa-f]{6}/g) ?? []).map((h) => h.toUpperCase());
    expect(used.length).toBeGreaterThan(0);
    for (const h of used) {
      // --auth-muted / --auth-dim are the one legitimate addition: a
      // light-on-navy ramp the brand simply does not have. Everything
      // else must already exist in app/landing.css.
      if (['#9FB3CC', '#8AA0BC'].includes(h)) continue;
      expect(brand).toContain(h);
    }
  });

  it('the two AA failures are gone and cannot come back', () => {
    // #7A90AD measured 4.44:1 on --navy, #8494A8 measured 3.10:1 on
    // white. Both carried real copy.
    const all = [
      CSS,
      codeOf('app/(auth)/login/page.tsx'),
      codeOf('app/(auth)/signup/SignupEntry.tsx'),
      codeOf('app/_components/ContinueWithGoogleButton.tsx'),
    ].join('\n');
    expect(all).not.toMatch(/#7A90AD/i);
    expect(all).not.toMatch(/#8494A8/i);
  });

  it('the accent is the brand teal-bright, not a second bright teal', () => {
    expect(AUTH).toMatch(/--auth-accent:\s*#19C2B6/);
    expect(LANDING).toMatch(/--teal-bright:#19c2b6/);
    // The invented one is retired everywhere, pill included.
    const all = [CSS, codeOf('app/_components/LastUsedPill.tsx'),
                 codeOf('app/(auth)/login/page.tsx'),
                 codeOf('app/(auth)/signup/SignupEntry.tsx')].join('\n');
    expect(all).not.toMatch(/#4FD8CD/i);
  });

  it('the decorative blobs introduce no hue at all', () => {
    // White at alpha over navy is a lighter navy; brand teal at alpha is
    // brand teal. Neither can drift out of family the way a hand-picked
    // mid-blue did.
    const blobs = SURFACE.slice(SURFACE.indexOf('function BrandBlobs'));
    expect(blobs).not.toMatch(/#[0-9A-Fa-f]{6}/);
    for (const rgb of (blobs.match(/rgba\((\d+),\s*(\d+),\s*(\d+)/g) ?? [])) {
      expect(['rgba(255,255,255', 'rgba(25,194,182', 'rgba(21,168,158']).toContain(rgb);
    }
  });
});

describe('the three options are one stack, not three components', () => {
  // WHAT WENT WRONG — TWICE — so it is recognisable if it returns.
  //
  // Measured on a 390px viewport at each stage:
  //
  //   1. Icon and label were centred together as a UNIT, so each
  //      button's contents depended on ITS OWN label width. Icons landed
  //      at x = 78 / 88 / 95.
  //   2. Pinning the icons to a left column fixed those (all 21) but
  //      simply moved the scatter to the text: 92 / 103 / 109.
  //   3. Anchoring BOTH left is what actually produces two columns —
  //      icons 21, labels 51 — and is the standard provider-stack
  //      layout.
  //
  // The lesson worth keeping: centring anything inside these buttons
  // re-couples position to label length. justify-center is the tell.
  //
  // ContinueWithGoogleButton also carried rounded-[14px] between two
  // rounded-full neighbours, so the middle option looked like a
  // different component wedged into the stack.

  const CHOOSER = LOGIN.slice(
    LOGIN.indexOf('data-testid="login-view-chooser"'),
    LOGIN.indexOf('data-testid="login-view-email"'),
  );
  const ENTRY = codeOf('app/(auth)/signup/SignupEntry.tsx');
  const stackControls = (src: string) =>
    src.match(/className="flex h-\[\d+px\] w-full items-center[^"]*"/g) ?? [];

  it('nothing in the stack is centred — that is what couples position to label length', () => {
    for (const c of [...stackControls(CHOOSER), ...stackControls(ENTRY)]) {
      expect(c).not.toMatch(/justify-center/);
    }
    expect(GOOGLE).not.toMatch(/items-center justify-center/);
  });

  it('every option opens the same two columns: icon then label', () => {
    // px-5 sets the icon column; gap-3 after an 18px icon sets the label
    // column. Same three tokens on every control, or they diverge.
    const controls = [...stackControls(CHOOSER), ...stackControls(ENTRY)];
    expect(controls.length).toBe(3); // passkey + email, and /signup's primary
    for (const c of controls) {
      expect(c).toMatch(/items-center gap-3 px-5/);
    }
    expect(GOOGLE).toMatch(/items-center gap-3 px-5/);
  });

  it('every option HAS an icon, so none of them starts its label early', () => {
    // /signup's primary had no icon: its label would have begun in the
    // icon column while its neighbour's began after the gap. Misaligned
    // by omission is still misaligned.
    const icons = [...CHOOSER.matchAll(/<svg className="([^"]*)"/g)].map((m) => m[1]);
    expect(icons.length).toBeGreaterThanOrEqual(2);
    for (const i of icons) expect(i).toMatch(/shrink-0/);
    expect(ENTRY).toMatch(/<svg className="h-\[18px\] w-\[18px\] shrink-0"/);
    expect(GOOGLE).toMatch(/<svg className="shrink-0"/);
  });

  it('all options share one height and one radius', () => {
    for (const c of [...stackControls(CHOOSER), ...stackControls(ENTRY)]) {
      expect(c).toMatch(/h-\[52px\]/);
      expect(c).toMatch(/rounded-full/);
    }
    expect(GOOGLE).toMatch(/h-\[52px\]/);
  });

  it('both dark stacks ask the Google button for the pill shape', () => {
    expect(CHOOSER).toMatch(/shape="pill"/);
    expect(ENTRY).toMatch(/shape="pill"/);
  });

  it('the shape stays opt-IN, so /signup/patient keeps its form geometry', () => {
    // That page sits the button above rounded-[14px] inputs; defaulting
    // to pill would make it the odd one out there instead.
    expect(GOOGLE).toMatch(/shape = 'rounded'/);
    expect(GOOGLE).toMatch(/shape === 'pill' \? 'rounded-full' : 'rounded-\[14px\]'/);
    expect(codeOf('app/signup/patient/PatientSignupForm.tsx')).not.toMatch(/shape=/);
  });
});
