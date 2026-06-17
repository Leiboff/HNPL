import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Password autocomplete attribute regression ───────────────────────────
//
// Browsers + password managers use the autocomplete attribute to
// decide what to offer in their UI:
//
//   - autocomplete="new-password"     → "would you like me to
//     generate and save a strong password?"  (CREATE flows)
//
//   - autocomplete="current-password" → "would you like me to fill
//     in the saved password?"               (LOGIN flow)
//
// Missing the attribute means the browser refuses to save a brand-
// new password (which is exactly the recovery-cliff scenario for
// patients who clicked through checkout). A login form lacking
// "current-password" silently doesn't autofill.
//
// This test pins which attribute lives where so the next refactor
// can't quietly drop them.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const FILES = {
  patientSignup:    read('app/signup/patient/PatientSignupForm.tsx'),
  practiceSignup:   read('app/signup/practice/page.tsx'),
  providerSetup:    read('app/provider/setup/page.tsx'),
  checkoutPwSet:    read('app/checkout/[token]/done/PasswordSetForm.tsx'),
  login:            read('app/(auth)/login/page.tsx'),
};

// Match `<input ... />` non-greedily across newlines. JSX `=>` arrow
// functions inside the tag (e.g. onChange={e => ...}) contain `>`,
// which trips up a naive `[^>]*` match — use `[\s\S]*?` instead so
// the regex consumes the whole tag up to the first self-closing `/>`.
const INPUT_TAG = /<input\b[\s\S]*?\/>/g;

function passwordInputs(src: string): string[] {
  return (src.match(INPUT_TAG) ?? []).filter(tag =>
    /type\s*=\s*['"]password['"]/.test(tag),
  );
}

// All CREATE-password forms must use new-password.
describe('CREATE-password forms use autoComplete="new-password"', () => {
  it.each([
    ['patient signup',                   FILES.patientSignup],
    ['practice signup',                  FILES.practiceSignup],
    ['provider setup',                   FILES.providerSetup],
    ['checkout /done set-password step', FILES.checkoutPwSet],
  ])('%s', (_label, src) => {
    const tags = passwordInputs(src);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).toMatch(/autoComplete\s*=\s*['"]new-password['"]/);
      expect(tag).not.toMatch(/autoComplete\s*=\s*['"]current-password['"]/);
    }
  });
});

describe('Login form uses autoComplete="current-password"', () => {
  it('the login password input is marked current-password (so saved passwords autofill)', () => {
    const tags = passwordInputs(FILES.login);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      // Either "current-password" alone or "current-password webauthn"
      // (the second token is supported by browsers + WebAuthn flows).
      expect(tag).toMatch(/autoComplete\s*=\s*['"]current-password(\s+webauthn)?['"]/);
    }
  });

  it('the login form does NOT use new-password (would break browser autofill)', () => {
    expect(FILES.login).not.toMatch(/autoComplete\s*=\s*['"]new-password['"]/);
  });
});

// Belt-and-braces: confirm every type="password" we found has SOME
// autocomplete attribute, so we never accidentally ship a passwordless
// input that the browser refuses to save.
describe('No password input ships without an autoComplete', () => {
  it.each([
    ['patient signup',                   FILES.patientSignup],
    ['practice signup',                  FILES.practiceSignup],
    ['provider setup',                   FILES.providerSetup],
    ['checkout /done set-password step', FILES.checkoutPwSet],
    ['login',                            FILES.login],
  ])('%s — every type="password" input has an autoComplete attribute', (_label, src) => {
    const tags = passwordInputs(src);
    expect(tags.length).toBeGreaterThan(0);  // sanity: we found the inputs
    for (const tag of tags) {
      expect(tag).toMatch(/autoComplete\s*=\s*['"]/);
    }
  });
});
