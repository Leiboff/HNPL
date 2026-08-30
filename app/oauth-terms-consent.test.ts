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

describe('every surface offering Google discloses the terms somehow', () => {
  // THE INVARIANT, restated as the surfaces changed.
  //
  // A Google click can create an account, so no surface may offer it
  // silently. There are three legal shapes, and what makes them legal
  // differs:
  //
  //   A. the button's own note (the default) — a disclosure.
  //   B. showConsentNote={false} + AuthConsentNote covering the whole
  //      stack — the same disclosure, once, for every option. /login
  //      takes this: it is a SIGN-IN screen, so a tick would tax every
  //      returning user for an agreement most of them gave long ago.
  //   C. showConsentNote={false} + an actual gating tick — an
  //      AGREEMENT, not merely a disclosure. /signup takes this,
  //      because it is where accounts are made.
  //
  // What must never exist is a fourth: offering the button with none of
  // them. This enumerates the callers and allows only A, B or C.

  const CALLERS = [
    'app/(auth)/login/page.tsx',
    'app/(auth)/signup/SignupEntry.tsx',
    'app/signup/patient/PatientSignupForm.tsx',
  ];

  it('every caller lands in one of the three shapes', () => {
    for (const p of CALLERS) {
      const src = codeOf(p);
      if (!/<ContinueWithGoogleButton/.test(src)) continue;
      if (/showConsentNote=\{false\}/.test(src)) {
        // B or C.
        expect(/<AuthConsentNote/.test(src) || /consentGiven=/.test(src)).toBe(true);
      } else {
        // A — must not have silently disabled the default.
        expect(src).not.toMatch(/showConsentNote/);
      }
    }
  });

  it('/signup takes shape C — a tick that actually blocks both routes', () => {
    expect(ENTRY).toMatch(/data-testid="signup-terms-checkbox"/);
    // Google is handed the value AND a way to refuse.
    expect(ENTRY).toMatch(/consentGiven=\{termsAccepted\}/);
    expect(ENTRY).toMatch(/onConsentMissing=\{requireTerms\}/);
    // The email route is gated by the same function.
    expect(ENTRY).toMatch(/function openForm\(\) \{\s*if \(!requireTerms\(\)\) return;/);
  });

  it('the tick is NOT pre-checked', () => {
    // A pre-ticked box is consent the visitor never gave — the textbook
    // example of what POPIA's "expression of will" and GDPR's "clear
    // affirmative action" exclude — and is functionally identical to the
    // passive line it replaced, since the visitor does nothing.
    expect(ENTRY).toMatch(/const \[termsAccepted, setTermsAccepted\] = useState\(false\);/);
    expect(ENTRY).toMatch(/checked=\{termsAccepted\}/);
    expect(ENTRY).not.toMatch(/useState\(true\)[\s\S]{0,80}termsAccepted/);
  });

  it('/login stays shape B — a sign-in screen must not tax returning users', () => {
    expect(LOGIN).toMatch(/showConsentNote=\{false\}/);
    expect(LOGIN).toMatch(/<AuthConsentNote/);
    expect(LOGIN).not.toMatch(/consentGiven=/);
  });

  it('the email form has no tick of its own — one agreement, not two', () => {
    const FORM = codeOf('app/signup/patient/PatientSignupForm.tsx');
    expect(FORM).not.toMatch(/patient-termsAccepted/);
    expect(FORM).not.toMatch(/href="\/legal\/terms"/);
    // It still receives the chooser's value and still passes it on.
    expect(FORM).toMatch(/termsAccepted: boolean/);
    expect(FORM).toMatch(/termsAccepted,/);
  });

  it('the shared note names both documents and links to both pages', () => {
    expect(NOTE).toMatch(/By \{action\} you agree to betternow/);
    expect(NOTE).toMatch(/href="\/legal\/terms"/);
    expect(NOTE).toMatch(/href="\/legal\/privacy"/);
    expect(NOTE).toMatch(/data-testid="auth-consent-note"/);
  });
});

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

  it('the callback records the tick — and ONLY the tick', () => {
    // It stamps when the chooser says the box was ticked, and writes
    // nothing otherwise. The earlier version stamped every OAuth
    // arrival on the strength of a passive line, which made the record
    // say more than the visitor had done.
    expect(CALLBACK_SRC).toMatch(/terms_accepted'\) === '1'/);
    expect(CALLBACK_SRC).toMatch(/consentGiven && !profile\.terms_accepted_at/);
    // Write-once, and never a hardcoded version.
    expect(CALLBACK_SRC).toMatch(/terms_version:\s*TERMS_VERSION/);
    expect(CALLBACK_SRC).not.toMatch(/terms_version:\s*['"]/);
  });

  it('the param is opt-in at the button, so no surface claims consent it never asked for', () => {
    expect(BUTTON).toMatch(/const consentParam = consentGiven \? '&terms_accepted=1' : '';/);
    expect(BUTTON).toMatch(/const blocked = consentGiven === false;/);
    // undefined means "not a consent moment" — /login keeps its old
    // behaviour and adds no parameter.
    expect(LOGIN).not.toMatch(/consentGiven=/);
  });

  it('the onboarding step REMAINS the floor — the param is client-asserted', () => {
    // The tick happens before a session exists, so the acceptance has to
    // travel as a query parameter, and a query parameter is asserted by
    // the client. The step catches anything arriving unstamped: the
    // param missing or dropped, or a new account created through
    // /login's Google button, which collects no tick.
    expect(STATE).toMatch(/if \(!user\.identity_providers\.includes\('email'\)\) steps\.push\('terms'\);/);
    expect(STEP_ACTION).toMatch(/if \(!accepted\) return \{ error:/);
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
