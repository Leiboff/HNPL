import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Terms + Privacy acceptance is RECORDED SERVER-SIDE ─────────────────
//
// The "I agree" ticks were captured client-side only — nothing reached
// the DB. This suite pins the close of that gap: at each acceptance
// moment the server stamps terms_accepted_at + terms_version AND
// privacy_version onto the record it pertains to. One combined tick
// covers both documents; terms_accepted_at is the shared timestamp.
// Source-text pins (they assert the WRITE shape), complementing the
// behavioural coverage below.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const SIGNUP   = read('app/signup/patient/actions.ts');
const CALLBACK = read('app/auth/callback/route.ts');
const PATIENT  = read('app/patient/actions.ts');
const CHECKOUT = read('app/checkout/[token]/actions.ts');
const MIGRATION      = read('supabase/migrations/0081_terms_acceptance.sql');
const MIGRATION_PRIV = read('supabase/migrations/0082_privacy_acceptance.sql');

// A plan-activation UPDATE that stamps acceptance. We look for the terms
// AND privacy fields appearing together inside a plans .update({...}) that
// also moves the plan to pending_first_payment.
function stampsAcceptanceOnActivation(src: string, occurrences: number) {
  const re = /\.update\(\{[\s\S]*?status:\s*'pending_first_payment'[\s\S]*?terms_accepted_at:\s*new Date\(\)\.toISOString\(\)[\s\S]*?terms_version:\s*TERMS_VERSION[\s\S]*?privacy_version:\s*PRIVACY_VERSION[\s\S]*?\}\)/g;
  const matches = src.match(re) ?? [];
  expect(matches.length).toBe(occurrences);
}

describe('signup records acceptance server-side', () => {
  it('gates on termsAccepted as a server decision (not just the client tick)', () => {
    expect(SIGNUP).toMatch(/termsAccepted:\s*boolean/);
    expect(SIGNUP).toMatch(/if \(!termsAccepted\)\s*return \{ error:/);
  });

  it('stamps profiles.terms_accepted_at + terms_version + privacy_version after signUp', () => {
    expect(SIGNUP).toMatch(/from '@\/lib\/legal\/terms'/);
    expect(SIGNUP).toMatch(/from '@\/lib\/legal\/privacy'/);
    // The three columns are written from ONE place now — the same payload
    // is needed by the stamp, the unfiltered retry, and the defensive
    // provision, and three inline copies of a legal record is how one of
    // them comes to be missing a column.
    expect(SIGNUP).toMatch(
      /function consentColumns\(\) \{\s*return \{\s*terms_accepted_at:\s*new Date\(\)\.toISOString\(\),\s*terms_version:\s*TERMS_VERSION,\s*privacy_version:\s*PRIVACY_VERSION,\s*\};/,
    );
    expect(SIGNUP).toMatch(/\.from\('profiles'\)\s*\.update\(consentColumns\(\)\)/);
    // …and the provisioned row carries them too, or a signup could exist
    // with a profile and no acceptance.
    expect(SIGNUP).toMatch(/\.insert\(\{[\s\S]*?\.\.\.consentColumns\(\),[\s\S]*?\}\)/);
  });
});

describe('Google (OAuth) signup records acceptance server-side', () => {
  // The OAuth path has no "I agree" checkbox of its own — the tick is
  // collected once on the /signup chooser, covering both routes, and
  // carried to /auth/callback, the first server-side moment after the
  // click. Full coverage of both halves (tick + record) lives in
  // app/oauth-terms-consent.test.ts; this is the pointer that keeps the
  // OAuth path visible from the suite that owns acceptance overall, so
  // it cannot be the one path someone forgets exists.
  it('records acceptance from the chooser tick, and refuses the session without it', () => {
    // Nothing is inferred: absent the parameter, nothing is written —
    // and nothing written means no session.
    //
    // The callback is no longer the ONLY floor, though. It said "there is
    // no onboarding step behind this any more, so the callback IS the
    // floor", and a single floor on a security rule turned out to be one
    // bug away from no floor: its refusal called signOut() without
    // reading the error signOut RETURNS when revocation fails, so a
    // refused arrival kept its session and reached an onboarding step.
    // The refusal is now terminal, and lib/legal/termsGate.ts re-checks
    // on every surface a session can reach. See
    // lib/legal/acceptance.test.ts.
    const CHOOSER = read('app/(auth)/signup/SignupEntry.tsx');
    expect(CHOOSER).toMatch(/data-testid="signup-terms-checkbox"/);
    expect(CHOOSER).toMatch(/consentGiven=\{termsAccepted\}/);
    expect(CALLBACK).toMatch(/terms_accepted'\) === '1'/);
    expect(CALLBACK).toMatch(/if \(needsAcceptance && !consentGiven\) return 'needs-terms';/);
    expect(CALLBACK).toMatch(/await supabase\.auth\.signOut\(\{ scope: 'global' \}\)/);
    expect(CALLBACK).toMatch(/clearAuthCookies\(refused,/);
  });

  it('the button that starts that flow carries the disclosure by default', () => {
    const BUTTON = read('app/_components/ContinueWithGoogleButton.tsx');
    expect(BUTTON).toMatch(/showConsentNote = true/);
    expect(BUTTON).toMatch(/href="\/legal\/terms"/);
    expect(BUTTON).toMatch(/href="\/legal\/privacy"/);
  });
});

describe('plan activation records acceptance server-side', () => {
  it('app/patient/actions.ts stamps terms + privacy on BOTH activation paths (acceptPlan + payWithSavedCard)', () => {
    expect(PATIENT).toMatch(/from '@\/lib\/legal\/terms'/);
    expect(PATIENT).toMatch(/from '@\/lib\/legal\/privacy'/);
    stampsAcceptanceOnActivation(PATIENT, 2);
  });

  it('app/checkout/[token]/actions.ts stamps terms + privacy on the plan-terms activation UPDATE', () => {
    expect(CHECKOUT).toMatch(/from '@\/lib\/legal\/terms'/);
    expect(CHECKOUT).toMatch(/from '@\/lib\/legal\/privacy'/);
    stampsAcceptanceOnActivation(CHECKOUT, 1);
  });

  it('checkout also records account-level acceptance (terms + privacy) on the profile upsert', () => {
    // Checkout-origin patients never pass through signUpPatient, so the
    // profile upsert is where their account-level accept is recorded.
    expect(CHECKOUT).toMatch(
      /const profileFields = \{[\s\S]*?terms_accepted_at:\s*new Date\(\)\.toISOString\(\),\s*terms_version:\s*TERMS_VERSION,\s*privacy_version:\s*PRIVACY_VERSION,[\s\S]*?\};/,
    );
  });
});

describe('both "I agree" checkboxes link to BOTH documents', () => {
  const CHECKOUT_FORM = read('app/checkout/[token]/CheckoutForm.tsx');

  it('signup label links to /legal/terms AND /legal/privacy', () => {
    // On the chooser now, not the email form — one tick for both routes.
    const CHOOSER = read('app/(auth)/signup/SignupEntry.tsx');
    expect(CHOOSER).toMatch(/href="\/legal\/terms"/);
    expect(CHOOSER).toMatch(/href="\/legal\/privacy"/);
  });

  it('checkout label links to /legal/terms AND /legal/privacy', () => {
    expect(CHECKOUT_FORM).toMatch(/href="\/legal\/terms"/);
    expect(CHECKOUT_FORM).toMatch(/href="\/legal\/privacy"/);
  });
});

describe('migration 0081 adds the columns additively', () => {
  it('adds terms_accepted_at + terms_version to profiles and plans, idempotently', () => {
    expect(MIGRATION).toMatch(/ALTER TABLE profiles ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ/);
    expect(MIGRATION).toMatch(/ALTER TABLE profiles ADD COLUMN IF NOT EXISTS terms_version\s+TEXT/);
    expect(MIGRATION).toMatch(/ALTER TABLE plans\s+ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ/);
    expect(MIGRATION).toMatch(/ALTER TABLE plans\s+ADD COLUMN IF NOT EXISTS terms_version\s+TEXT/);
  });

  it('is non-destructive — no DROP / DELETE / backfill UPDATE statement', () => {
    // Match SQL STATEMENTS, not prose (the comment banner mentions the
    // word "UPDATE" when describing the app-side writes).
    expect(MIGRATION).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i);
    expect(MIGRATION).not.toMatch(/DELETE\s+FROM/i);
    expect(MIGRATION).not.toMatch(/UPDATE\s+\w+\s+SET/i);
  });
});

describe('migration 0082 adds privacy_version additively', () => {
  it('adds privacy_version TEXT to profiles and plans, idempotently', () => {
    expect(MIGRATION_PRIV).toMatch(/ALTER TABLE profiles ADD COLUMN IF NOT EXISTS privacy_version TEXT/);
    expect(MIGRATION_PRIV).toMatch(/ALTER TABLE plans\s+ADD COLUMN IF NOT EXISTS privacy_version TEXT/);
  });

  it('is non-destructive — no DROP / DELETE / backfill UPDATE statement', () => {
    expect(MIGRATION_PRIV).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i);
    expect(MIGRATION_PRIV).not.toMatch(/DELETE\s+FROM/i);
    expect(MIGRATION_PRIV).not.toMatch(/UPDATE\s+\w+\s+SET/i);
  });
});
