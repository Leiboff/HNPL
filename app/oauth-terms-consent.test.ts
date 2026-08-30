import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Google sign-up records T&C + Privacy acceptance ────────────────────
//
// THE GAP THIS CLOSES.
//
// Acceptance was captured on every path EXCEPT the OAuth one:
//
//   • /signup/patient  → "I agree" tick, gated server-side in
//     signUpPatient, stamped onto profiles (migrations 0081 + 0082).
//   • /checkout/[token] → same tick, stamped on the profile upsert.
//   • Plan activation   → stamped on the plan.
//   • "Continue with Google" → NOTHING. Supabase provisioned the auth
//     user, the 0024 trigger created the profile with role='patient',
//     and the patient reached /patient fully able to take a plan with
//     profiles.terms_accepted_at NULL — never having been shown the
//     terms at all.
//
// Two halves fix it, and this file pins both, because either one alone
// is worthless: a stamp with no disclosure records a consent that was
// never asked for, and a disclosure with no stamp leaves nothing to
// audit.
//
//   1. DISCLOSURE — ContinueWithGoogleButton renders the terms +
//      privacy line beneath itself BY DEFAULT, so a surface cannot
//      acquire the button without acquiring the notice. The one opt-out
//      (showConsentNote={false}) exists for a caller that renders an
//      equivalent line covering the button; /signup is the only user of
//      it and is pinned below to carry that line.
//   2. RECORD — /auth/callback stamps terms_accepted_at + terms_version
//      + privacy_version onto the profile for OAuth arrivals, using the
//      same lib/legal constants every other path writes.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const codeOf = (p: string) => stripComments(read(p));

const BUTTON   = codeOf('app/_components/ContinueWithGoogleButton.tsx');
const CALLBACK = codeOf('app/auth/callback/route.ts');
const ENTRY    = codeOf('app/(auth)/signup/SignupEntry.tsx');
const LOGIN    = codeOf('app/(auth)/login/page.tsx');
const NOTE     = codeOf('app/_components/AuthConsentNote.tsx');

// ─── 1. Disclosure at the click ────────────────────────────────────────

describe('ContinueWithGoogleButton discloses the terms', () => {
  it('renders the consent note by DEFAULT — a surface cannot get the button without it', () => {
    expect(BUTTON).toMatch(/showConsentNote\s*=\s*true/);
    expect(BUTTON).toMatch(/\{showConsentNote && \(/);
  });

  it('the note names both documents and links to both pages', () => {
    expect(BUTTON).toMatch(/By continuing with Google you agree to our/);
    expect(BUTTON).toMatch(/href="\/legal\/terms"/);
    expect(BUTTON).toMatch(/href="\/legal\/privacy"/);
  });

  it('exposes a stable testid so the disclosure can be asserted on any surface', () => {
    expect(BUTTON).toMatch(/data-testid="google-consent-note"/);
  });

  it('the legal links open in a new tab with rel=noopener (same posture as the signup tick)', () => {
    const noteStart = BUTTON.indexOf('showConsentNote && (');
    const note = BUTTON.slice(noteStart, BUTTON.indexOf('{error &&', noteStart));
    expect(note.match(/target="_blank"/g) ?? []).toHaveLength(2);
    expect(note.match(/rel="noopener"/g) ?? []).toHaveLength(2);
  });
});

describe('a surface may suppress the button note ONLY by covering the stack itself', () => {
  // THE INVARIANT, stated once.
  //
  // The disclosure is what makes the acceptance /auth/callback records
  // legitimate, so it must be present on every surface that can create
  // an account. There are exactly two legal shapes:
  //
  //   A. the button's own note (the default), or
  //   B. showConsentNote={false} PLUS AuthConsentNote covering the whole
  //      stack — which is stronger, since it also covers the passkey and
  //      email options that have no note of their own.
  //
  // What must never exist is a third shape: opting out and rendering
  // nothing. This test enumerates every caller and allows only A or B.

  const CALLERS = [
    'app/(auth)/login/page.tsx',
    'app/(auth)/signup/SignupEntry.tsx',
    'app/signup/patient/PatientSignupForm.tsx',
  ];

  it('every caller of the Google button lands in one of the two legal shapes', () => {
    for (const p of CALLERS) {
      const src = codeOf(p);
      if (!/<ContinueWithGoogleButton/.test(src)) continue;
      const optsOut = /showConsentNote=\{false\}/.test(src);
      if (optsOut) {
        // Shape B — must render the stack-wide note instead.
        expect(src).toMatch(/<AuthConsentNote/);
      } else {
        // Shape A — must NOT have silently disabled the default.
        expect(src).not.toMatch(/showConsentNote/);
      }
    }
  });

  it('/login and /signup both take shape B — one line under every option', () => {
    for (const src of [LOGIN, ENTRY]) {
      expect(src).toMatch(/showConsentNote=\{false\}/);
      expect(src).toMatch(/<AuthConsentNote/);
    }
  });

  it('the shared note names both documents and links to both pages', () => {
    expect(NOTE).toMatch(/By \{action\} you agree to betternow/);
    expect(NOTE).toMatch(/href="\/legal\/terms"/);
    expect(NOTE).toMatch(/href="\/legal\/privacy"/);
    expect(NOTE).toMatch(/data-testid="auth-consent-note"/);
    expect(NOTE.match(/target="_blank"/g) ?? []).toHaveLength(2);
    expect(NOTE.match(/rel="noopener"/g) ?? []).toHaveLength(2);
  });

  it('the line sits BELOW the options on both screens, so it covers them all', () => {
    expect(ENTRY.indexOf('<AuthConsentNote'))
      .toBeGreaterThan(ENTRY.indexOf('data-testid="signup-entry-methods"'));
    // On /login the stack ends with the email option.
    expect(LOGIN.indexOf('<AuthConsentNote'))
      .toBeGreaterThan(LOGIN.indexOf('data-testid="login-open-email"'));
  });

  it('neither screen states the terms twice', () => {
    // Two legal lines on one screen read as two different promises.
    for (const src of [LOGIN, ENTRY]) {
      expect(src.match(/<AuthConsentNote/g) ?? []).toHaveLength(1);
    }
  });
});

// ─── 2. The record, server-side ────────────────────────────────────────

describe('/auth/callback records the acceptance for OAuth arrivals', () => {
  it('reads the versions from the same single sources every other path uses', () => {
    expect(CALLBACK).toMatch(/from '@\/lib\/legal\/terms'/);
    expect(CALLBACK).toMatch(/from '@\/lib\/legal\/privacy'/);
    // Never a hardcoded version string — that is how the audit trail
    // drifts away from the published documents.
    expect(CALLBACK).not.toMatch(/terms_version:\s*['"]/);
    expect(CALLBACK).not.toMatch(/privacy_version:\s*['"]/);
  });

  it('selects terms_accepted_at so it can tell "already accepted" from "never"', () => {
    expect(CALLBACK).toMatch(/\.select\('id, first_name, last_name, role, terms_accepted_at'\)/);
  });

  it('stamps all three columns when nothing is recorded yet', () => {
    expect(CALLBACK).toMatch(
      /const consent: Record<string, unknown> = profile\.terms_accepted_at\s*\?\s*\{\}\s*:\s*\{\s*terms_accepted_at:\s*new Date\(\)\.toISOString\(\),\s*terms_version:\s*TERMS_VERSION,\s*privacy_version:\s*PRIVACY_VERSION,\s*\}/,
    );
  });

  it('NEVER overwrites an existing acceptance — the audit trail is not re-versioned', () => {
    // The ternary above is the whole guard: a truthy terms_accepted_at
    // yields an empty patch. Pin that the write is the merge of the two
    // objects and nothing wider.
    expect(CALLBACK).toMatch(/\.update\(\{ \.\.\.updates, \.\.\.consent \}\)\.eq\('id', userId\)/);
  });

  it('the defensively-provisioned row gets the same stamp (it must not be the one that escapes)', () => {
    const insertIdx = CALLBACK.indexOf(".from('profiles').insert(");
    expect(insertIdx).toBeGreaterThan(-1);
    const insert = CALLBACK.slice(insertIdx, CALLBACK.indexOf('return;', insertIdx));
    expect(insert).toMatch(/terms_accepted_at:\s*new Date\(\)\.toISOString\(\)/);
    expect(insert).toMatch(/terms_version:\s*TERMS_VERSION/);
    expect(insert).toMatch(/privacy_version:\s*PRIVACY_VERSION/);
  });

  it('still returns early when there is genuinely nothing to write', () => {
    expect(CALLBACK).toMatch(
      /if \(Object\.keys\(updates\)\.length === 0 && Object\.keys\(consent\)\.length === 0\) return;/,
    );
  });

  it('the name-sync payload is still names-only — the stamp did not widen it', () => {
    const scope = CALLBACK.slice(CALLBACK.indexOf('async function ensureOAuthProfileSynced'));
    const setters = scope.match(/updates\.\w+/g) ?? [];
    expect(setters.length).toBeGreaterThan(0);
    for (const s of setters) {
      expect(['first_name', 'last_name']).toContain(s.replace('updates.', ''));
    }
  });

  it('the stamp stays inside the OAuth-only branch — a password reset lands here too', () => {
    // ensureOAuthProfileSynced is the ONLY place the consent object is
    // built, and it is called only for users with a non-email identity.
    expect((CALLBACK.match(/const consent:/g) ?? []).length).toBe(1);
    const syncStart = CALLBACK.indexOf('async function ensureOAuthProfileSynced');
    const syncEnd   = CALLBACK.indexOf('export async function GET');
    const consentIdx = CALLBACK.indexOf('const consent:');
    expect(consentIdx).toBeGreaterThan(syncStart);
    expect(consentIdx).toBeLessThan(syncEnd);
    expect(CALLBACK).toMatch(/identities\.some\(\(i\)\s*=>\s*i\.provider\s*!==\s*'email'\)/);
  });
});
