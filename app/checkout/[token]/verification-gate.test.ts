import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── A patient may not pay before their ID and credit checks pass ─────────
//
// Product decision, 2026-09-02, closing audit A-05.
//
// ─── WHAT WAS WRONG ───────────────────────────────────────────────────────
//
// BetterNow had four doors onto a payment plan. Three of them (acceptPlan,
// payWithSavedCard, and the /onboarding flow that feeds them) ran
// `requireOnboarded`: email confirmed, phone verified, salary captured,
// IDENTITY verified by Didit with a liveness face match, and a credit check
// PASSED. The fourth — `initiateCheckout`, the counter/QR door — ran a phone
// OTP and nothing else.
//
// So a caller with a stolen SA ID number and a phone of their own could take
// a plan at a till: no Didit, no face match, no credit check, no affordability
// assessment. HNPL then paid the practice 94% of the bill on first-payment
// success, which is what turns a verification gap into a cash-out.
//
// It compounded with a second hole in the same action: the credit-limit read
// was wrapped in `if (!isNewUser)`, on the reasoning that an account created
// seconds earlier cannot have a limit yet. True, and it made "be a new
// account" the way to take on a bill with no per-customer ceiling at all —
// and this action creates accounts, from an email the caller supplies.
//
// ─── WHAT CLOSED IT ───────────────────────────────────────────────────────
//
// This action stops being a second front door. It identifies the patient,
// binds the bill to them, and then hands off to the flow that already
// enforces everything — nothing below the gate runs until onboarding is
// complete. No schedule, no Peach checkout, no charge.
//
// The `isNewUser` carve-out is gone entirely rather than being patched: the
// credit decision now lives in `claim_credit_for_plan` (migration 0130) and
// runs for every account. A new account has no approved limit, so it is
// refused there — which is the correct answer, and is only reachable if the
// gate above somehow let a new account through.
//
// The first-time patient at a counter is not turned away: they are routed
// through Didit and the credit check and come back to the SAME token, which
// is still live (activation is what closes a token, not a detour). The return
// trip charges normally and still vaults the card in one step, so the
// one-tap card-and-charge is preserved — it just happens after verification.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

const ACTIONS = read('app/checkout/[token]/actions.ts');
const FORM    = read('app/checkout/[token]/CheckoutForm.tsx');
const STATE   = read('lib/onboarding/state.ts');
const ALLOW   = readFileSync(resolve(ROOT, 'supabase/migrations/0122_profiles_column_allowlist.sql'), 'utf8');

function initiateCheckoutBody(): string {
  const start = ACTIONS.indexOf('export async function initiateCheckout');
  expect(start).toBeGreaterThan(-1);
  const next = ACTIONS.indexOf('export async function', start + 1);
  return ACTIONS.slice(start, next === -1 ? undefined : next);
}

describe('the gate asks the same question as the other three doors', () => {
  it('calls computeOnboarding rather than re-listing the steps', () => {
    // The defect was two doors with two different ideas of "verified". A
    // second hand-written step list here would be the same defect with more
    // steps in it, so the fix is one call to the shared computation.
    expect(ACTIONS).toMatch(/import \{ computeOnboarding, type ProfileForOnboarding \} from '@\/lib\/onboarding\/state'/);
    const fn = ACTIONS.slice(ACTIONS.indexOf('async function checkoutOnboardingStatus'));
    expect(fn).toMatch(/computeOnboarding\(/);
    // …over the same flags, or a flag-gated step could be enforced on one
    // door and skipped on the other.
    expect(fn).toMatch(/currentFlags\(\)/);
  });

  it('reads every column the shared step list actually consults', () => {
    // A select that misses a column reads undefined, and undefined is
    // indistinguishable from "not verified" for some steps and from
    // "verified" for none — but the failure mode worth pinning is the select
    // drifting away from stepIsSatisfied.
    const fn = ACTIONS.slice(
      ACTIONS.indexOf('async function checkoutOnboardingStatus'),
      ACTIONS.indexOf('function signInRequired('),
    );
    for (const col of [
      'phone_verified_at',
      'sa_id_number',
      'salary_day',
      'salary_amount',
      'credit_check_status',
      'liveness_verified_at',
      'onboarding_completed',
    ]) {
      expect(fn).toContain(col);
      // Same column, named by the shared computation — this is the pin that
      // trips if a step starts reading something new.
      expect(STATE).toContain(col);
    }
    // email_confirmed_at comes off the auth user, not the profile row.
    expect(fn).toMatch(/auth\.admin\.getUserById\(userId\)/);
    expect(fn).toMatch(/email_confirmed_at:\s*authUser\?\.user\?\.email_confirmed_at/);
  });

  it('the identity step means Didit AND the liveness face match', () => {
    // Named here because it is the specific thing A-05 let a caller skip: an
    // SA ID typed into a form is not identity, and neither column is
    // patient-writable (see the allow-list test below).
    expect(STATE).toMatch(/case 'identity':[\s\S]{0,600}profile\.sa_id_number && !!profile\.liveness_verified_at/);
    expect(STATE).toMatch(/case 'credit-check':[\s\S]{0,120}credit_check_status === 'passed'/);
  });

  it('a brand-new account is never treated as verified', () => {
    // The short-circuit that matters: an account created moments ago by this
    // same action has nothing to read, and the answer must be "not yet"
    // rather than an empty-profile fall-through.
    const fn = ACTIONS.slice(ACTIONS.indexOf('async function checkoutOnboardingStatus'));
    expect(fn).toMatch(/if \(isNewUser\) return \{ done: false, path: '\/onboarding' \}/);
  });

  it('fails closed when the profile cannot be read', () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf('async function checkoutOnboardingStatus'));
    expect(fn).toMatch(/if \(!profile\) return \{ done: false, path: '\/onboarding' \}/);
  });

  it('the columns it reads are not writable by the patient (audit F-05, migration 0122)', () => {
    // The gate is a read of seven profile columns, so it is only worth as
    // much as the RLS above them. Cross-referenced rather than assumed,
    // because this door now depends on it for money.
    for (const col of [
      'sa_id_number', 'liveness_verified_at', 'salary_day', 'salary_amount',
      'credit_check_status', 'onboarding_completed',
    ]) {
      expect(ALLOW).toContain(col);
    }
  });
});

describe('nothing that costs money happens before the gate', () => {
  const body = initiateCheckoutBody();
  const at   = (needle: string) => {
    const i = body.indexOf(needle);
    expect(i, `expected to find ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  const gate = at('const onboarding = await checkoutOnboardingStatus(');

  it('refuses with the stable verification_required code and a route onward', () => {
    expect(body).toMatch(/if \(!onboarding\.done\) \{/);
    expect(body).toMatch(/error:\s*'verification_required'/);
    expect(body).toMatch(/requireOnboarding: true/);
    // Returns to THIS token, so the bill is waiting when they come back.
    expect(body).toMatch(/onboardingUrl:\s*`\$\{appUrl\}\$\{onboarding\.path\}\?next=\$\{encodeURIComponent\(`\/checkout\/\$\{token\}`\)\}`/);
  });

  it('the credit claim runs AFTER the gate', () => {
    expect(at('claimCreditForPlan(svc, {')).toBeGreaterThan(gate);
  });

  it('the Peach checkout is created AFTER the gate', () => {
    expect(at('provider.createCheckout')).toBeGreaterThan(gate);
  });

  it('the session is minted AFTER the gate', () => {
    expect(at('generateLink(')).toBeGreaterThan(gate);
  });

  it('the plan is bound BEFORE the gate — deliberately', () => {
    // The one write that must precede it. A patient sent off to Didit with an
    // unbound bill comes back to a plan nothing recognises as theirs; binding
    // first is what makes the round trip resumable. It grants nothing: an
    // owned plan at pending_acceptance has no schedule and no charge.
    expect(at("update({ patient_id: userId })")).toBeLessThan(gate);
  });
});

describe('the isNewUser credit carve-out is gone, not narrowed', () => {
  const body = initiateCheckoutBody();

  it('no credit decision is skipped for a new account', () => {
    // The literal shape of the defect. `checkCreditLimit` is no longer
    // called from this action at all — the claim decides, for everyone.
    expect(body).not.toMatch(/checkCreditLimit/);
    expect(body).not.toMatch(/if \(!isNewUser\) \{[\s\S]{0,200}limit/i);
  });

  it('these are the ONLY things this action still branches on isNewUser for', () => {
    // Enumerated rather than spot-checked, because A-05's shape was a gate
    // hidden behind this exact flag and the way it comes back is somebody
    // adding a fourth branch. Each survivor earns its place:
    //
    //   isPatientFrozen   — an account created seconds ago provably has no
    //                       prior defaulted plan. A query saved, not a gate
    //                       dropped.
    //   session overwrite — the A-03 backstop: refuse to write over an
    //                       EXISTING profile from a counter token.
    //   the else-branch   — createUser's own `isNewUser = true`.
    //
    // Notably absent: anything to do with credit, limits or verification.
    const conditions = body.match(/if \([^)]*isNewUser[^)]*\)/g) ?? [];
    expect(conditions).toEqual([
      'if (!isNewUser && (await isPatientFrozen(svc, userId)',
      "if (!isNewUser && resolved.kind === 'session')",
      'if (isNewUser)',
    ]);
  });
});

describe('the patient is told what to do, not just refused', () => {
  it('the form has a branch for the gate that offers the next step', () => {
    expect(FORM).toMatch(/'requireOnboarding' in result && result\.requireOnboarding/);
    expect(FORM).toMatch(/setNextStep\(\{ url: result\.onboardingUrl, label: 'Verify my ID' \}\)/);
    expect(FORM).toMatch(/verify your ID and run a/);
  });

  it('it does NOT navigate on its own', () => {
    // At a counter with a receptionist watching, a page that redirects itself
    // somewhere unexplained is how a patient walks away mid-transaction.
    const branch = FORM.slice(
      FORM.indexOf("'requireOnboarding' in result"),
      FORM.indexOf("setNextStep({ url: result.onboardingUrl"),
    );
    expect(branch).not.toMatch(/router\.(push|replace)|location\.(assign|href)/);
  });

  it('the raw code never reaches the patient as copy', () => {
    // 'verification_required' is a protocol value for the form to switch on,
    // not a sentence. The branch sets its own copy and returns before the
    // generic `setError(result.error)` further down.
    const from   = FORM.indexOf("'requireOnboarding' in result");
    const branch = FORM.slice(from, FORM.indexOf('return;', FORM.indexOf('setNextStep({ url: result.onboardingUrl', from)));
    expect(branch).not.toMatch(/setError\(result\.error\)/);
    expect(branch).toMatch(/setError\(\s*'Before you can split this bill/);
  });

  it('the requireOnboarding shape is in the action result union', () => {
    expect(ACTIONS).toMatch(/\{ ok: false; error: string; requireOnboarding: true; onboardingUrl: string \}/);
    expect(FORM).toMatch(/\{ ok: false; error: string; requireOnboarding: true; onboardingUrl: string \}/);
  });
});
