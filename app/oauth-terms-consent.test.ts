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
    expect(BUTTON).toMatch(/By continuing with Google you agree to betternow/);
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

  it('both notes name the brand identically', () => {
    // Two of the three auth screens carry AuthConsentNote and one carries
    // the button's own note. They must not describe the same documents as
    // belonging to different parties — "our" on one screen and
    // "betternow's" on the others reads as an oversight, and was one.
    expect(NOTE).toMatch(/agree to betternow/);
    expect(codeOf('app/_components/ContinueWithGoogleButton.tsx')).toMatch(/agree to betternow/);
    for (const src of [NOTE, codeOf('app/_components/ContinueWithGoogleButton.tsx')]) {
      expect(src).not.toMatch(/agree to our/);
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

describe('the OAuth path AGREES — actively, like the email path', () => {
  // WHAT THIS USED TO PIN, and why it changed.
  //
  // The first fix for the Google gap was inference: a "by continuing…"
  // line beside the button, and /auth/callback stamping
  // terms_accepted_at on arrival. Defensible as sign-in-wrap, and
  // strictly weaker than what the email path does — where an unticked
  // box has to be ticked and signUpPatient refuses without it.
  //
  // The agreement is now an explicit onboarding step, so these
  // assertions moved with it. The callback must NOT stamp any more:
  // doing so would pre-satisfy the step and skip the very screen that
  // collects the agreement.

  const CALLBACK_SRC = codeOf('app/auth/callback/route.ts');
  const STEP_PAGE    = codeOf('app/onboarding/terms/page.tsx');
  const STEP_ACTION  = codeOf('app/onboarding/terms/actions.ts');
  const STEP_CLIENT  = codeOf('app/onboarding/terms/TermsStepClient.tsx');
  const STATE        = codeOf('lib/onboarding/state.ts');

  it('the callback no longer stamps acceptance — that would skip the step', () => {
    expect(CALLBACK_SRC).not.toMatch(/terms_accepted_at:/);
    expect(CALLBACK_SRC).not.toMatch(/TERMS_VERSION/);
    expect(CALLBACK_SRC).not.toMatch(/PRIVACY_VERSION/);
  });

  it('the step is FIRST for OAuth paths, so nothing can be reached before it', () => {
    // A gate that is not first is not a gate.
    expect(STATE).toMatch(/if \(!user\.identity_providers\.includes\('email'\)\) steps\.push\('terms'\);/);
    expect(STATE).toMatch(/case 'terms':\s*return !!profile\.terms_accepted_at;/);
  });

  it('the email path has no terms STEP — it has the tick in the form instead', () => {
    // Both paths agree actively; they just do it in the place that suits
    // each. Adding the step to the email list would show a screen whose
    // answer was already given.
    expect(STATE).toMatch(/if \(user\.identity_providers\.includes\('email'\)\) steps\.push\('verify-email'\);/);
    expect(codeOf('app/signup/patient/actions.ts')).toMatch(/if \(!termsAccepted\)\s*return \{ error:/);
  });

  it('the tick is unticked, names both documents, and gates the button', () => {
    // Same shape as the email form's tick — nothing pre-ticked, nothing
    // inferred from having got this far.
    expect(STEP_CLIENT).toMatch(/useState\(false\)/);
    expect(STEP_CLIENT).toMatch(/href="\/legal\/terms"/);
    expect(STEP_CLIENT).toMatch(/href="\/legal\/privacy"/);
    expect(STEP_CLIENT).toMatch(/disabled=\{!accepted \|\| pending\.disabled\}/);
  });

  it('acceptance is a SERVER decision, not a client checkbox', () => {
    // The checkbox is an affordance; a hand-crafted POST can omit it.
    expect(STEP_ACTION).toMatch(/'use server'/);
    expect(STEP_ACTION).toMatch(/if \(!accepted\) return \{ error:/);
    expect(STEP_ACTION).toMatch(/await supabase\.auth\.getUser\(\)/);
  });

  it('it stamps all three columns from the same single sources', () => {
    expect(STEP_ACTION).toMatch(/from '@\/lib\/legal\/terms'/);
    expect(STEP_ACTION).toMatch(/from '@\/lib\/legal\/privacy'/);
    expect(STEP_ACTION).toMatch(/terms_accepted_at:\s*new Date\(\)\.toISOString\(\)/);
    expect(STEP_ACTION).toMatch(/terms_version:\s*TERMS_VERSION/);
    expect(STEP_ACTION).toMatch(/privacy_version:\s*PRIVACY_VERSION/);
    // Never a hardcoded version string.
    expect(STEP_ACTION).not.toMatch(/terms_version:\s*['"]/);
  });

  it('write-once — an existing acceptance is never re-versioned', () => {
    // The audit trail records what the customer ORIGINALLY agreed to.
    expect(STEP_ACTION).toMatch(/\.is\('terms_accepted_at', null\)/);
  });

  it('the step page refuses to render for anyone it is not the step for', () => {
    // Stops an email-path user reaching a screen absent from their list,
    // and stops anyone re-agreeing to something already recorded.
    expect(STEP_PAGE).toMatch(/if \(status\.done \|\| status\.step !== 'terms'\) \{\s*redirect\('\/onboarding'\);/);
  });
});
