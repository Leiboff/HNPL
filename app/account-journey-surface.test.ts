import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── One surface for the whole account journey ─────────────────────────
//
// Everything between "I want an account" and "I'm in the app" is now one
// design: the navy AuthSurface, the .auth-surface tokens, the shared
// wordmark, and the control vocabulary in
// app/_components/authFormStyles.ts.
//
// It was two designs before this. /login and /signup were navy; the
// /onboarding steps, /verify-email, /verify-phone, /auth/confirmed and
// the password-reset pair were white cards on a pale wash. A patient
// crossed between them twice in the first two minutes of using the
// product — signup (navy) → verify email (white) → phone (white) →
// dashboard — and each crossing looked like landing in a different app.
//
// These are source-regex pins, in the style of
// app/(auth)/login/login-auth-surface.test.ts. They cannot see a
// rendered pixel; what they CAN do is catch the specific way this drifts,
// which is a new screen (or a rewritten old one) quietly reaching for
// bg-white, a #13294B-on-white heading, or its own copy of the field
// classes. If you are adding a screen to the journey, add it to SCREENS.

const ROOT = resolve(process.cwd());
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/**
 * Every screen in the journey, and how it gets onto the surface: either it
 * renders <AuthSurface> itself, or it renders <OnboardingShell>, which
 * does. Step CLIENTS are listed too — they render inside the shell and
 * are where the light-ground styling actually lived.
 */
const SCREENS: ReadonlyArray<{ rel: string; via: 'surface' | 'shell' | 'inside' }> = [
  // The arrival screens — already on the surface before this pass; here so
  // a regression on them fails with everything else.
  { rel: 'app/(auth)/login/page.tsx',                              via: 'surface' },
  { rel: 'app/(auth)/signup/SignupEntry.tsx',                      via: 'surface' },
  { rel: 'app/signup/patient/PatientSignupForm.tsx',               via: 'inside'  },

  // The onboarding steps.
  { rel: 'components/onboarding/OnboardingShell.tsx',              via: 'surface' },
  { rel: 'app/onboarding/verify-email/page.tsx',                   via: 'shell'   },
  { rel: 'app/onboarding/phone/page.tsx',                          via: 'shell'   },
  { rel: 'app/onboarding/salary/page.tsx',                         via: 'shell'   },
  { rel: 'app/onboarding/identity/page.tsx',                       via: 'shell'   },
  { rel: 'app/onboarding/credit-check/page.tsx',                   via: 'shell'   },
  { rel: 'app/onboarding/phone/PhoneStepClient.tsx',               via: 'inside'  },
  { rel: 'app/onboarding/salary/SalaryStepClient.tsx',             via: 'inside'  },
  { rel: 'app/onboarding/identity/IdentityStepClient.tsx',         via: 'inside'  },
  { rel: 'app/onboarding/credit-check/CreditCheckStepClient.tsx',  via: 'inside'  },

  // The verification + recovery screens either side of them.
  { rel: 'app/verify-email/page.tsx',                              via: 'surface' },
  { rel: 'app/verify-email/VerifyEmailForm.tsx',                   via: 'inside'  },
  { rel: 'app/(auth)/verify-phone/page.tsx',                       via: 'surface' },
  { rel: 'app/(auth)/verify-phone/VerifyPhoneClient.tsx',          via: 'inside'  },
  { rel: 'app/auth/confirmed/ConfirmedView.tsx',                   via: 'surface' },
  { rel: 'app/forgot-password/page.tsx',                           via: 'surface' },
  { rel: 'app/forgot-password/ForgotPasswordForm.tsx',             via: 'inside'  },
  { rel: 'app/update-password/page.tsx',                           via: 'surface' },
  { rel: 'app/update-password/UpdatePasswordForm.tsx',             via: 'inside'  },
];

describe('Account journey — every screen is on the shared auth surface', () => {
  it.each(SCREENS.filter(s => s.via === 'surface'))('$rel renders <AuthSurface>', ({ rel }) => {
    const src = read(rel);
    expect(src).toMatch(/from '@\/app\/_components\/AuthSurface'/);
    expect(src).toMatch(/<AuthSurface[\s>]/);
  });

  it.each(SCREENS.filter(s => s.via === 'shell'))('$rel renders <OnboardingShell>', ({ rel }) => {
    expect(read(rel)).toMatch(/<OnboardingShell[\s>]/);
  });

  it('the onboarding shell sits on the surface rather than its own white card', () => {
    const SHELL = read('components/onboarding/OnboardingShell.tsx');
    expect(SHELL).toMatch(/from '@\/app\/_components\/AuthSurface'/);
    // The v2 card: a white panel on a pale blue-grey wash.
    expect(SHELL).not.toMatch(/bg-white/);
    expect(SHELL).not.toMatch(/#E9EFF1/);
  });

  it('the onboarding layout paints the navy, so a step transition cannot flash white', () => {
    const LAYOUT = read('app/onboarding/layout.tsx');
    expect(LAYOUT).toMatch(/bg-\[#0E2140\]/);
    expect(LAYOUT).not.toMatch(/bg-\[#f7fbfb\]/);
  });
});

// ─── No light-ground styling left in the journey ──────────────────────

describe('Account journey — no light-ground styling survives', () => {
  // The specific values the pale design was built from. Each is a real
  // colour used elsewhere in the app on white cards; on the navy they are
  // either invisible (navy text) or a bright chip (white fills).
  const LIGHT_GROUND = [
    // An OPAQUE white fill — the card. `bg-white/[.03]` and friends are
    // white AT ALPHA, which over the navy is simply a lighter navy and is
    // exactly what the surface's own fills are made of.
    /bg-white(?!\/)/,
    /bg-gray-50\b/,
    /#f7fbfb/i,                   // the app's pale teal-white
    /#E9EFF1/i,                   // the v2 onboarding wash
    /#FBFCFD/i,                   // the light field fill
    /#E2E8EE/i,                   // the light field border
    /text-gray-[5-9]00/,          // light-ground body copy
    /bg-red-50\b/, /bg-amber-50\b/, /bg-emerald-50\b/,  // light banners
    /linear-gradient\(135deg, #13294B/,                 // the old CTA fill
  ];

  it.each(SCREENS)('$rel carries no light-ground values', ({ rel }) => {
    // Comments explain the migration and legitimately name the old
    // values; strip them before matching.
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const pattern of LIGHT_GROUND) {
      expect(src, `${rel} matched ${pattern}`).not.toMatch(pattern);
    }
  });

  it('navy is never used as a TEXT colour in the journey (it is the ground)', () => {
    for (const { rel } of SCREENS) {
      const src = read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src, `${rel} sets navy text`).not.toMatch(/color:\s*'#13294B'/);
      expect(src, `${rel} sets navy text`).not.toMatch(/text-\[#13294B\]/);
    }
  });
});

// ─── One vocabulary, not N copies of it ───────────────────────────────

describe('Account journey — controls come from the shared vocabulary', () => {
  const VOCAB = 'app/_components/authFormStyles.ts';

  it('the vocabulary is expressed in --auth-* tokens, so it can only be used on the surface', () => {
    const src = read(VOCAB);
    expect(src).toMatch(/var\(--auth-fill-raised\)/);
    expect(src).toMatch(/var\(--auth-teal\)/);
    expect(src).toMatch(/var\(--auth-on-teal\)/);
    // No hex ramp of its own — the palette lives in the .auth-surface
    // token block in app/globals.css and nowhere else.
    expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('every screen that renders a field or a button imports the vocabulary', () => {
    const WITH_CONTROLS = [
      'app/onboarding/phone/PhoneStepClient.tsx',
      'app/onboarding/salary/SalaryStepClient.tsx',
      'app/onboarding/identity/IdentityStepClient.tsx',
      'app/onboarding/credit-check/CreditCheckStepClient.tsx',
      'app/verify-email/VerifyEmailForm.tsx',
      'app/forgot-password/ForgotPasswordForm.tsx',
      'app/update-password/UpdatePasswordForm.tsx',
      'app/auth/confirmed/ConfirmedView.tsx',
    ];
    for (const rel of WITH_CONTROLS) {
      expect(read(rel), rel).toMatch(/from '@\/app\/_components\/authFormStyles'/);
    }
  });

  it('the pre-split onboarding vocabulary is gone, not left beside the shared one', () => {
    // app/onboarding/formStyles.ts was the light-ground INPUT_CLS /
    // BUTTON_CLS pair. Two vocabularies for one journey is how this drifts
    // back, so it was deleted rather than kept as an alias.
    //
    // existsSync rather than a read() that is expected to throw: the
    // path-integrity guard in app/test-path-integrity.test.ts scans this
    // file for read() targets and requires every one of them to exist,
    // and it is right to — a read of a missing file is normally an
    // invisible collection error.
    expect(existsSync(resolve(ROOT, 'app/onboarding/formStyles.ts'))).toBe(false);
    for (const { rel } of SCREENS) {
      expect(read(rel), rel).not.toMatch(/onboarding\/formStyles/);
    }
  });

  it('the wordmark is one component, not re-inlined per screen', () => {
    const MARK = read('app/_components/AuthWordmark.tsx');
    expect(MARK).toMatch(/var\(--auth-accent\)/);
    for (const rel of [
      'app/(auth)/login/page.tsx',
      'app/(auth)/signup/SignupEntry.tsx',
      'components/onboarding/OnboardingShell.tsx',
      'app/verify-email/page.tsx',
      'app/(auth)/verify-phone/page.tsx',
      'app/forgot-password/ForgotPasswordForm.tsx',
      'app/update-password/UpdatePasswordForm.tsx',
      'app/auth/confirmed/ConfirmedView.tsx',
    ]) {
      const src = read(rel);
      expect(src, rel).toMatch(/<AuthWordmark\b/);
      // No local copy of the two spans beside the shared one.
      expect(src, rel).not.toMatch(/better<span/);
      expect(src, rel).not.toMatch(/>better<\/span>/);
    }
  });
});

// ─── The phone step is built like the email one ───────────────────────

describe('Phone step — the same shape as the email-confirmation screen', () => {
  const PHONE = read('app/onboarding/phone/PhoneStepClient.tsx');

  it('has no bespoke on-screen keypad', () => {
    // A tray of ten digit buttons under the field. It duplicated the OS
    // keyboard that inputMode="numeric" already raises, and it made this
    // the one screen in the journey with a widget of its own.
    const src = PHONE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/'1',\s*'2',\s*'3'/);
    expect(src).not.toMatch(/appendDigit/);
    expect(src).not.toMatch(/grid-cols-3/);
  });

  it('raises the numeric pad through the field itself', () => {
    expect(PHONE).toMatch(/inputMode="numeric"/);
    expect(PHONE).toMatch(/type="tel"/);
    expect(PHONE).toMatch(/autoComplete="tel"/);
  });

  it('pins its CTA to the body floor, as the email screen does', () => {
    expect(PHONE).toMatch(/mt-auto/);
    expect(read('app/verify-email/VerifyEmailForm.tsx')).toMatch(/mt-auto/);
  });
});

// ─── The shared components serve both grounds ─────────────────────────
//
// OtpInput, PhoneOtpStep and SalaryDayPicker are used BOTH in the journey
// (dark) and on the white checkout / patient-profile cards (light). They
// take a `tone` rather than being forked, so the OTP a patient types at
// signup and the one they type at checkout stay the same control.

describe('Shared controls — one component, two tones', () => {
  const TONED = [
    'components/OtpInput.tsx',
    'app/_otp/PhoneOtpStep.tsx',
    'components/SalaryDayPicker.tsx',
  ];

  it.each(TONED)('%s takes a tone and defaults to light', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/tone\?:/);
    expect(src).toMatch(/tone\s*=\s*'light'/);
    expect(src).toMatch(/onDark:/);
  });

  it.each(TONED)('%s keeps its dark values in --auth-* tokens', (rel) => {
    // The onDark table specifically — the light table legitimately holds
    // the app's light hexes.
    const src = read(rel);
    const dark = src.slice(src.indexOf('onDark:'), src.indexOf('};', src.indexOf('onDark:')));
    expect(dark).toMatch(/var\(--auth-/);
  });

  it('the dark call sites ask for the dark tone', () => {
    for (const rel of [
      'app/onboarding/phone/PhoneStepClient.tsx',
      'app/onboarding/salary/SalaryStepClient.tsx',
      'app/(auth)/verify-phone/VerifyPhoneClient.tsx',
      'app/verify-email/VerifyEmailForm.tsx',
    ]) {
      expect(read(rel), rel).toMatch(/tone="onDark"/);
    }
  });

  it('the light call sites are untouched — they pass no tone and stay light', () => {
    for (const rel of [
      'app/checkout/[token]/CheckoutForm.tsx',
      'app/patient/profile/PhoneField.tsx',
    ]) {
      expect(read(rel), rel).not.toMatch(/tone="onDark"/);
    }
  });
});

// ─── Loading fallbacks match the screen they precede ──────────────────

describe('Account journey — route fallbacks are on the same ground', () => {
  const DARK_FALLBACKS = [
    'app/onboarding/loading.tsx',
    'app/verify-email/loading.tsx',
    'app/(auth)/verify-phone/loading.tsx',
    'app/update-password/loading.tsx',
    'app/auth/confirmed/loading.tsx',
    'app/signup/patient/loading.tsx',
  ];

  it.each(DARK_FALLBACKS)('%s uses AuthSurfaceShape, not the light card shape', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/<AuthSurfaceShape\b/);
    expect(src).not.toMatch(/<AuthCardShape\b/);
    expect(src).not.toMatch(/<FormShape\b/);
  });

  it('AuthSurfaceShape paints the same ground AuthSurface does', () => {
    const SHAPES  = read('components/loading/shapes.tsx');
    const SURFACE = read('app/_components/AuthSurface.tsx');
    // Both start from --navy-deep → --navy. Pinned as literals in the
    // skeleton because it renders OUTSIDE .auth-surface and so cannot
    // read the tokens.
    expect(SHAPES).toMatch(/#0E2140/);
    expect(SHAPES).toMatch(/#13294B/);
    expect(SURFACE).toMatch(/--auth-ground-from/);
    // And the same accent wash, so the swap doesn't shift the light.
    expect(SHAPES).toMatch(/rgba\(21,168,158,\.30\)/);
  });

  it('the dark skeleton uses the shared on-dark fill, not an ad-hoc override', () => {
    const SHAPES = read('components/loading/shapes.tsx');
    expect(SHAPES).toMatch(/SKELETON_ON_DARK/);
    // `!important` class overrides in the caller were the alternative;
    // the fill is a prop precisely so both tones are written down once.
    expect(SHAPES).not.toMatch(/!bg-white/);
  });
});
