import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
  // WHAT THIS USED TO PIN, and why it changed. Twice.
  //
  // The first fix for the Google gap was inference: a "by continuing…"
  // line beside the button, and /auth/callback stamping
  // terms_accepted_at on arrival. Defensible as sign-in-wrap, and
  // strictly weaker than what the email path does.
  //
  // The second was an onboarding step — a real tick, but AFTER the
  // session existed. That is the part that did not hold up: a step is a
  // screen an unaccepted, fully authenticated account sits in front of,
  // and every account reaching it was already an account.
  //
  // The rule now is that acceptance is a PRECONDITION of the session,
  // enforced at the two doors:
  //
  //   • email  → signUpPatient confirms the row was written and DELETES
  //     the auth user it just created if it wasn't.
  //   • Google → /auth/callback confirms the row was written and signs
  //     the arrival back out if it wasn't.
  //
  // So there is no terms step, and this suite pins its absence as
  // firmly as it used to pin its presence: re-adding one would mean the
  // door had stopped holding.

  const CALLBACK_SRC = codeOf('app/auth/callback/route.ts');
  const SIGNUP_SRC   = codeOf('app/signup/patient/actions.ts');
  const STATE        = codeOf('lib/onboarding/state.ts');

  it('the callback records the tick — and ONLY the tick', () => {
    // It stamps when the chooser says the box was ticked, and writes
    // nothing otherwise. The earlier version stamped every OAuth
    // arrival on the strength of a passive line, which made the record
    // say more than the visitor had done.
    expect(CALLBACK_SRC).toMatch(/terms_accepted'\) === '1'/);
    expect(CALLBACK_SRC).toMatch(/if \(needsAcceptance && !consentGiven\) return 'needs-terms';/);
    // Write-once, and never a hardcoded version.
    expect(CALLBACK_SRC).toMatch(/terms_version:\s*TERMS_VERSION/);
    expect(CALLBACK_SRC).not.toMatch(/terms_version:\s*['"]/);
  });

  it('the param is opt-in at the button, so no surface claims consent it never asked for', () => {
    expect(BUTTON).toMatch(/const consentParam = consentGiven \? '&terms_accepted=1' : '';/);
    expect(BUTTON).toMatch(/const blocked = consentGiven === false;/);
    // undefined means "not a consent moment" — /login adds no parameter,
    // which is why a NEW account arriving through it is refused below.
    expect(LOGIN).not.toMatch(/consentGiven=/);
  });

  it('an unaccepted OAuth arrival does not keep its session', () => {
    // THE GATE. Not "is asked later" — does not keep its session. The
    // cookies the exchange just set are cleared and the visitor is
    // returned to /signup, where the tick lives.
    expect(CALLBACK_SRC).toMatch(/if \(outcome !== 'ok'\) \{/);
    expect(CALLBACK_SRC).toMatch(/\/signup\?error=\$\{outcome === 'write-failed' \? 'terms_write' : 'terms'\}/);

    // This used to assert `await supabase.auth.signOut();` and nothing
    // more, which is precisely the shape that leaked: signOut REPORTS a
    // failed revocation by returning `{ error }` and skips removing the
    // stored session, so the visitor was shown the accept-the-terms
    // screen while still signed in. Revoke globally, read the returned
    // error, and delete the cookies on the response actually returned.
    expect(CALLBACK_SRC).toMatch(/const \{ error: signOutError \} = await supabase\.auth\.signOut\(\{ scope: 'global' \}\)/);
    expect(CALLBACK_SRC).toMatch(/if \(signOutError\)/);
    expect(CALLBACK_SRC).toMatch(/clearAuthCookies\(refused, request\.cookies\.getAll\(\)/);
  });

  it('a FAILED write is refused just as hard as a missing tick', () => {
    // "It didn't save" and "they never agreed" leave the same database
    // row, so they get the same answer. The distinction survives only
    // in the sentence the visitor reads.
    expect(CALLBACK_SRC).toMatch(/type OAuthSyncOutcome = 'ok' \| 'needs-terms' \| 'write-failed';/);
    // An update matching NO rows is not an error in PostgREST, so the
    // column is read back rather than the error being trusted.
    expect(CALLBACK_SRC).toMatch(/\.select\('terms_accepted_at'\)/);
    expect(CALLBACK_SRC).toMatch(/if \(writeErr \|\| !written\?\.length \|\| !written\[0\]\.terms_accepted_at\)/);
    // And a thrown error fails CLOSED — this used to be swallowed.
    expect(CALLBACK_SRC).toMatch(/outcome = 'write-failed';/);
  });

  it('the ONE exception is an already-onboarded account, and it is server-set', () => {
    // Accounts that finished onboarding before any of this existed keep
    // working. onboarding_completed is never written by anything the
    // visitor controls, so this cannot be claimed into.
    //
    // The rule moved to lib/legal/acceptance.ts when three more surfaces
    // started asking the same question — a second copy of a grandfather
    // clause is how two gates come to disagree. The callback now asks it
    // rather than restating it; the clause itself is pinned, with its
    // fixtures, in lib/legal/acceptance.test.ts.
    expect(CALLBACK_SRC).toMatch(/const needsAcceptance = !hasAcceptedTerms\(profile\);/);
    const ACCEPTANCE = read('lib/legal/acceptance.ts');
    expect(ACCEPTANCE).toMatch(/profile\.onboarding_completed === true/);
  });

  it('the email path refuses too — and ROLLS BACK the account it just made', () => {
    // The stamp used to be best-effort here: log and carry on, leaving a
    // live customer with no record of agreeing to anything. Now the auth
    // user created moments earlier in the same request is deleted, so a
    // failed signup leaves nothing behind to strand the next attempt on
    // "an account with this email already exists".
    // recordAcceptance now returns a REASON rather than a bare boolean,
    // because "the write was refused" and "there was no row to write to"
    // are not the same thing and only the first should cost an account.
    // The rollback below is unchanged for the first.
    expect(SIGNUP_SRC).toMatch(/const accepted = newUserId \? await recordAcceptance\(svc, newUserId, seed\) : null;/);
    expect(SIGNUP_SRC).toMatch(/if \(!newUserId \|\| !accepted\?\.ok\) \{/);
    expect(SIGNUP_SRC).toMatch(/await svc\.auth\.admin\.deleteUser\(newUserId\)/);
    expect(SIGNUP_SRC).not.toMatch(/console\.warn\('terms acceptance stamp on signup failed/);
  });

  it('recordAcceptance confirms the row, it does not trust a null error', () => {
    expect(SIGNUP_SRC).toMatch(/async function recordAcceptance\(/);
    expect(SIGNUP_SRC).toMatch(/\.select\('id'\)/);
    // Write-once — an existing acceptance is never re-dated.
    expect(SIGNUP_SRC).toMatch(/\.is\('terms_accepted_at', null\)/);
    // Zero rows is ambiguous, so it reads the column back rather than
    // guessing — and now distinguishes all three cases it can find:
    // already accepted, row present but unstamped, and no row at all.
    expect(SIGNUP_SRC).toMatch(/async function acceptanceOnRecord\(/);
    expect(SIGNUP_SRC).toMatch(/if \(state\.accepted\) return \{ ok: true, how: 'already-on-record' \};/);
    // Behaviour for each of those is driven through the real action in
    // app/signup/patient/signup-acceptance-recovery.test.ts.
  });

  it('the half-finished-signup branch is gated too, without dead-ending', () => {
    // An unconfirmed account being resumed may predate the requirement.
    // It is re-stamped before the OTP is resent. The AUTH_ONLY orphan (no
    // profile row) is now PROVISIONED rather than reported as a failure,
    // so the delete-and-recreate below is reached only when the database
    // actually refuses the write.
    expect(SIGNUP_SRC).toMatch(/const recovered = await recordAcceptance\(svc, existing\.id, seed\);/);
    expect(SIGNUP_SRC).toMatch(/if \(recovered\.ok\) \{/);
    expect(SIGNUP_SRC).toMatch(/await svc\.auth\.admin\.deleteUser\(existing\.id\)/);
  });

  it('an already-registered email is never reported as a terms failure', () => {
    // GoTrue returns a FAKE user with an empty identities array, rather
    // than an error, when both Confirm-email and Confirm-phone are on and
    // the address already exists. Untreated it walked into the stamp,
    // found no row for an id that was never real, and told the visitor we
    // could not record their agreement — for an email already registered.
    expect(SIGNUP_SRC).toMatch(/newUser\.identities\.length === 0/);
    expect(SIGNUP_SRC).toMatch(/if \(isObfuscated\) \{/);
  });

  it('there is NO terms onboarding step, on any path', () => {
    // Its absence is the point, not an omission. If the doors hold,
    // every account reaching onboarding already has an acceptance, and
    // a step could only ever be a screen nobody sees — a dead gate that
    // reads like a live one.
    expect(STATE).not.toMatch(/'terms'/);
    expect(STATE).not.toMatch(/steps\.push\('terms'\)/);
    expect(existsSync(resolve(ROOT, 'app/onboarding/terms'))).toBe(false);
  });

  it('the email path still gates on the tick before creating anything', () => {
    expect(STATE).toMatch(/if \(user\.identity_providers\.includes\('email'\)\) steps\.push\('verify-email'\);/);
    expect(SIGNUP_SRC).toMatch(/if \(!termsAccepted\)\s*return \{ error:/);
  });
});
