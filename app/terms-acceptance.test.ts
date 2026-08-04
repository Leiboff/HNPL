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
    expect(SIGNUP).toMatch(
      /\.from\('profiles'\)\s*\.update\(\{\s*terms_accepted_at:\s*new Date\(\)\.toISOString\(\),\s*terms_version:\s*TERMS_VERSION,\s*privacy_version:\s*PRIVACY_VERSION\s*\}\)/,
    );
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
  const SIGNUP_FORM   = read('app/signup/patient/PatientSignupForm.tsx');
  const CHECKOUT_FORM = read('app/checkout/[token]/CheckoutForm.tsx');

  it('signup label links to /legal/terms AND /legal/privacy', () => {
    expect(SIGNUP_FORM).toMatch(/href="\/legal\/terms"/);
    expect(SIGNUP_FORM).toMatch(/href="\/legal\/privacy"/);
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
