import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Terms acceptance is RECORDED SERVER-SIDE ───────────────────────────
//
// The "I agree" ticks were captured client-side only — nothing reached
// the DB. This suite pins the close of that gap: at each acceptance
// moment the server stamps terms_accepted_at + terms_version onto the
// record it pertains to. Source-text pins (they assert the WRITE shape),
// complementing the behavioural coverage of these actions elsewhere.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const SIGNUP   = read('app/signup/patient/actions.ts');
const PATIENT  = read('app/patient/actions.ts');
const CHECKOUT = read('app/checkout/[token]/actions.ts');
const MIGRATION = read('supabase/migrations/0081_terms_acceptance.sql');

// A plan-activation UPDATE that stamps terms. We look for the two terms
// fields appearing together inside a plans .update({...}) that also moves
// the plan to pending_first_payment.
function stampsTermsOnActivation(src: string, occurrences: number) {
  const re = /\.update\(\{[\s\S]*?status:\s*'pending_first_payment'[\s\S]*?terms_accepted_at:\s*new Date\(\)\.toISOString\(\)[\s\S]*?terms_version:\s*TERMS_VERSION[\s\S]*?\}\)/g;
  const matches = src.match(re) ?? [];
  expect(matches.length).toBe(occurrences);
}

describe('signup records acceptance server-side', () => {
  it('gates on termsAccepted as a server decision (not just the client tick)', () => {
    expect(SIGNUP).toMatch(/termsAccepted:\s*boolean/);
    expect(SIGNUP).toMatch(/if \(!termsAccepted\)\s*return \{ error:/);
  });

  it('stamps profiles.terms_accepted_at + terms_version after signUp', () => {
    expect(SIGNUP).toMatch(/from '@\/lib\/legal\/terms'/);
    expect(SIGNUP).toMatch(
      /\.from\('profiles'\)\s*\.update\(\{\s*terms_accepted_at:\s*new Date\(\)\.toISOString\(\),\s*terms_version:\s*TERMS_VERSION\s*\}\)/,
    );
  });
});

describe('plan activation records acceptance server-side', () => {
  it('app/patient/actions.ts stamps terms on BOTH activation paths (acceptPlan + payWithSavedCard)', () => {
    expect(PATIENT).toMatch(/from '@\/lib\/legal\/terms'/);
    stampsTermsOnActivation(PATIENT, 2);
  });

  it('app/checkout/[token]/actions.ts stamps terms on the plan-terms activation UPDATE', () => {
    expect(CHECKOUT).toMatch(/from '@\/lib\/legal\/terms'/);
    stampsTermsOnActivation(CHECKOUT, 1);
  });

  it('checkout also records account-level acceptance on the profile upsert', () => {
    // Checkout-origin patients never pass through signUpPatient, so the
    // profile upsert is where their account-level accept is recorded.
    expect(CHECKOUT).toMatch(
      /const profileFields = \{[\s\S]*?terms_accepted_at:\s*new Date\(\)\.toISOString\(\),\s*terms_version:\s*TERMS_VERSION,[\s\S]*?\};/,
    );
  });
});

describe('both "I agree" checkboxes link to the terms page', () => {
  const SIGNUP_FORM   = read('app/signup/patient/PatientSignupForm.tsx');
  const CHECKOUT_FORM = read('app/checkout/[token]/CheckoutForm.tsx');

  it('signup terms label links to /legal/terms', () => {
    expect(SIGNUP_FORM).toMatch(/href="\/legal\/terms"/);
  });

  it('checkout payment-plan terms label links to /legal/terms', () => {
    expect(CHECKOUT_FORM).toMatch(/href="\/legal\/terms"/);
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
    // The only writes are ADD COLUMN + COMMENT; no data-mutating UPDATE.
    expect(MIGRATION).not.toMatch(/UPDATE\s+\w+\s+SET/i);
  });
});
