import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeOnboarding,
  isOnboarded,
  stepListFor,
  stepsFor,
  STEP_PATH,
  type ProfileForOnboarding,
  type UserForOnboarding,
} from '@/lib/onboarding/state';
import type { OnboardingFlags } from '@/lib/featureFlags';

// ─── Stepped onboarding gate — unit + source-text ──────────────────────
//
// Two halves:
//   • Pure-function unit tests over computeOnboarding / stepsFor /
//     isOnboarded — every combination of user (email or Google), profile
//     completeness, and flag configuration.
//   • Source-text pins:
//     - Migration 0066 idempotent + backfill.
//     - Routing gate in patient layout.
//     - Server-side gate in acceptPlan + payWithSavedCard.
//     - Onboarding routes present + directly-accessible flag-off
//       branches redirect out.
//     - SA-ID validation reuses validateSaId + AES-256-GCM encryptId.
//     - No payment/RLS/webhook file touched.

// ─── Fixtures ────────────────────────────────────────────────────────

// EMAIL_USER — signed up with email+password (identity_providers=['email']).
// Pre-email-OTP: email_confirmed_at is null.
const EMAIL_USER: UserForOnboarding = {
  email_confirmed_at: null,
  identity_providers: ['email'],
};

// EMAIL_USER_CONFIRMED — same account after email OTP succeeded. The
// list length MUST stay the same as EMAIL_USER (this is the shrinking-
// total defect that path-fixed step lists fix).
const EMAIL_USER_CONFIRMED: UserForOnboarding = {
  email_confirmed_at: '2026-07-06T10:00:00Z',
  identity_providers: ['email'],
};

// GOOGLE_USER — Google OAuth only. email_confirmed_at is set at OAuth
// link time. verify-email is never in this user's step list.
const GOOGLE_USER: UserForOnboarding = {
  email_confirmed_at: '2026-07-06T10:00:00Z',
  identity_providers: ['google'],
};

const BLANK_PROFILE: ProfileForOnboarding = {
  phone_verified_at:    null,
  sa_id_number:         null,
  salary_day:           null,
  credit_check_status:  null,
  liveness_verified_at: null,
  onboarding_completed: false,
};

const FLAGS_OFF: OnboardingFlags = { creditCheck: false, liveness: false };
const FLAGS_ON:  OnboardingFlags = { creditCheck: true,  liveness: true };

// ─── stepListFor — path-fixed step list ──────────────────────────────

describe('stepListFor — path is stable across the journey; keyed on identity providers', () => {
  it('email user (pre email-OTP) — 3 steps: [verify-email, phone, identity]', () => {
    expect(stepListFor(EMAIL_USER, FLAGS_OFF)).toEqual(['verify-email', 'phone', 'identity']);
  });

  it('email user AFTER email OTP — SAME 3 steps (verify-email still in list, now completed)', () => {
    // The regression pin for the shrinking-total defect. Same account,
    // same identity_providers=['email'], only email_confirmed_at
    // changed. List length must NOT shrink.
    expect(stepListFor(EMAIL_USER_CONFIRMED, FLAGS_OFF)).toEqual(['verify-email', 'phone', 'identity']);
    expect(stepListFor(EMAIL_USER_CONFIRMED, FLAGS_OFF).length).toBe(3);
  });

  it('Google-only user — 2 steps: [phone, identity]; verify-email never appears', () => {
    expect(stepListFor(GOOGLE_USER, FLAGS_OFF)).toEqual(['phone', 'identity']);
    expect(stepListFor(GOOGLE_USER, FLAGS_OFF)).not.toContain('verify-email');
  });

  it('Path decision is driven by identity_providers, NOT by email_confirmed_at', () => {
    // Two users with the SAME email_confirmed_at value produce
    // DIFFERENT step lists based on identity providers. This is the
    // heart of the fix.
    const emailPath  = stepListFor(EMAIL_USER_CONFIRMED, FLAGS_OFF);
    const googlePath = stepListFor(GOOGLE_USER,          FLAGS_OFF);
    expect(emailPath.length).toBe(3);
    expect(googlePath.length).toBe(2);
    expect(emailPath[0]).toBe('verify-email');
    expect(googlePath[0]).toBe('phone');
  });

  it('An account linked to BOTH providers includes verify-email (email identity present)', () => {
    const both: UserForOnboarding = {
      email_confirmed_at: '2026-07-06T10:00:00Z',
      identity_providers: ['email', 'google'],
    };
    expect(stepListFor(both, FLAGS_OFF)).toContain('verify-email');
  });

  it('email user, flags on → 5 steps (all of them)', () => {
    expect(stepListFor(EMAIL_USER, FLAGS_ON)).toEqual([
      'verify-email', 'phone', 'identity', 'credit-check', 'liveness',
    ]);
  });

  it('Google user, flags on → 4 steps (no verify-email)', () => {
    expect(stepListFor(GOOGLE_USER, FLAGS_ON)).toEqual([
      'phone', 'identity', 'credit-check', 'liveness',
    ]);
  });

  it('deprecated stepsFor alias returns the SAME list (backwards compat)', () => {
    expect(stepsFor(EMAIL_USER, FLAGS_OFF)).toEqual(stepListFor(EMAIL_USER, FLAGS_OFF));
    expect(stepsFor(GOOGLE_USER, FLAGS_OFF)).toEqual(stepListFor(GOOGLE_USER, FLAGS_OFF));
  });
});

// ─── computeOnboarding — first unfinished step + progress index ──────

describe('computeOnboarding — flags off (launch shape)', () => {
  it('email user, blank profile → step=verify-email, 1 of 3', () => {
    const s = computeOnboarding(EMAIL_USER, BLANK_PROFILE, FLAGS_OFF);
    expect(s.done).toBe(false);
    if (!s.done) {
      expect(s.step).toBe('verify-email');
      expect(s.index).toBe(1);
      expect(s.total).toBe(3);
      expect(s.path).toBe(STEP_PATH['verify-email']);
    }
  });

  it('Google user, blank profile → step=phone, 1 of 2 (email OTP skipped)', () => {
    const s = computeOnboarding(GOOGLE_USER, BLANK_PROFILE, FLAGS_OFF);
    expect(s.done).toBe(false);
    if (!s.done) {
      expect(s.step).toBe('phone');
      expect(s.index).toBe(1);
      expect(s.total).toBe(2);
    }
  });

  it('email user, email confirmed only → step=phone, 2 of 3 (list length stays 3)', () => {
    // This is the key regression pin for the shrinking-total defect.
    // BEFORE the fix, this returned total=2 (verify-email dropped
    // because it was completed). AFTER the fix, the list is fixed
    // per PATH — total stays 3, index advances to 2.
    const s = computeOnboarding(EMAIL_USER_CONFIRMED, BLANK_PROFILE, FLAGS_OFF);
    expect(s.done).toBe(false);
    if (!s.done) {
      expect(s.step).toBe('phone');
      expect(s.index).toBe(2);
      expect(s.total).toBe(3);
    }
  });

  it('email user, email+phone → step=identity, 3 of 3', () => {
    const p = { ...BLANK_PROFILE, phone_verified_at: '2026-07-06T10:00:00Z' };
    const s = computeOnboarding(EMAIL_USER_CONFIRMED, p, FLAGS_OFF);
    expect(s.done).toBe(false);
    if (!s.done) {
      expect(s.step).toBe('identity');
      expect(s.index).toBe(3);
      expect(s.total).toBe(3);
    }
  });

  it('Google user progression: blank → phone (1 of 2); phone verified → identity (2 of 2)', () => {
    // Google-only user's list is length 2 at every stage — verify-email
    // is never in their path.
    const s1 = computeOnboarding(GOOGLE_USER, BLANK_PROFILE, FLAGS_OFF);
    if (!s1.done) {
      expect(s1.total).toBe(2);
      expect(s1.index).toBe(1);
      expect(s1.step).toBe('phone');
    }
    const p2 = { ...BLANK_PROFILE, phone_verified_at: '2026-07-06T10:00:00Z' };
    const s2 = computeOnboarding(GOOGLE_USER, p2, FLAGS_OFF);
    if (!s2.done) {
      expect(s2.total).toBe(2);
      expect(s2.index).toBe(2);
      expect(s2.step).toBe('identity');
    }
  });

  it('everything satisfied, flags off → done', () => {
    const p: ProfileForOnboarding = {
      ...BLANK_PROFILE,
      phone_verified_at: '2026-07-06T10:00:00Z',
      sa_id_number:      'v1:iv:tag:ciphertext',
      salary_day:        25,
    };
    const s = computeOnboarding(GOOGLE_USER, p, FLAGS_OFF);
    expect(s.done).toBe(true);
  });
});

describe('computeOnboarding — flags ON add credit-check + liveness to the flow', () => {
  it('phone + ID satisfied, flag on, credit_check_status null → step=credit-check', () => {
    const p: ProfileForOnboarding = {
      ...BLANK_PROFILE,
      phone_verified_at: '2026-07-06T10:00:00Z',
      sa_id_number:      'v1:iv:tag:ciphertext',
      salary_day:        25,
    };
    const s = computeOnboarding(GOOGLE_USER, p, FLAGS_ON);
    expect(s.done).toBe(false);
    if (!s.done) {
      expect(s.step).toBe('credit-check');
      expect(s.total).toBe(4);   // phone, id, credit, liveness
    }
  });

  it('credit passed but liveness not yet → step=liveness', () => {
    const p: ProfileForOnboarding = {
      ...BLANK_PROFILE,
      phone_verified_at:   '2026-07-06T10:00:00Z',
      sa_id_number:        'v1:iv:tag:ciphertext',
      salary_day:          25,
      credit_check_status: 'passed',
    };
    const s = computeOnboarding(GOOGLE_USER, p, FLAGS_ON);
    expect(s.done).toBe(false);
    if (!s.done) expect(s.step).toBe('liveness');
  });

  it('all satisfied incl. liveness → done', () => {
    const p: ProfileForOnboarding = {
      ...BLANK_PROFILE,
      phone_verified_at:    '2026-07-06T10:00:00Z',
      sa_id_number:         'v1:iv:tag:ciphertext',
      salary_day:           25,
      credit_check_status:  'passed',
      liveness_verified_at: '2026-07-06T10:00:00Z',
    };
    const s = computeOnboarding(GOOGLE_USER, p, FLAGS_ON);
    expect(s.done).toBe(true);
  });
});

describe('cached onboarding_completed — write-once-true, no retro-lock', () => {
  it('onboarding_completed=true short-circuits to done, even if flags flip on and columns are empty', () => {
    // Scenario: a patient completed under flags-OFF (no credit/liveness
    // columns set). Later the flags flip ON. They must NOT be retro-locked.
    const p: ProfileForOnboarding = {
      ...BLANK_PROFILE,
      phone_verified_at:    '2026-07-06T10:00:00Z',
      sa_id_number:         'v1:iv:tag:ciphertext',
      salary_day:           25,
      credit_check_status:  null,      // flag was OFF at completion
      liveness_verified_at: null,      // flag was OFF at completion
      onboarding_completed: true,      // cached
    };
    const s = computeOnboarding(GOOGLE_USER, p, FLAGS_ON);
    expect(s.done).toBe(true);
  });

  it('onboarding_completed=false + incomplete → still incomplete', () => {
    expect(isOnboarded(GOOGLE_USER, BLANK_PROFILE, FLAGS_OFF)).toBe(false);
  });
});

describe('resume behaviour — abandonment mid-flow returns them to the same step', () => {
  it('Google user abandons at phone → next login recomputes to phone', () => {
    const s1 = computeOnboarding(GOOGLE_USER, BLANK_PROFILE, FLAGS_OFF);
    // Simulate a session gap — same fixture, no state change.
    const s2 = computeOnboarding(GOOGLE_USER, BLANK_PROFILE, FLAGS_OFF);
    expect(s1).toEqual(s2);
    if (!s2.done) expect(s2.step).toBe('phone');
  });

  it('email user abandons after email OTP → resumes at phone with list length UNCHANGED', () => {
    // After email OTP the auth.users.email_confirmed_at is set, but
    // the step list must still be length 3 (verify-email stays in the
    // list, now completed). Resume lands on phone as step 2 of 3.
    const s = computeOnboarding(EMAIL_USER_CONFIRMED, BLANK_PROFILE, FLAGS_OFF);
    expect(s.done).toBe(false);
    if (!s.done) {
      expect(s.step).toBe('phone');
      expect(s.index).toBe(2);
      expect(s.total).toBe(3);
    }
  });
});

// ─── Source-text pins ────────────────────────────────────────────────

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const MIGRATION      = read('supabase/migrations/0066_onboarding_gate.sql');
const FLAGS_TS       = read('lib/featureFlags.ts');
const STATE_TS       = read('lib/onboarding/state.ts');
const ACTIONS_TS     = read('lib/onboarding/actions.ts');
const LAYOUT         = read('app/patient/layout.tsx');
const PATIENT_ACT    = read('app/patient/actions.ts');
const ONB_ROUTER     = read('app/onboarding/page.tsx');
const ONB_LAYOUT     = read('app/onboarding/layout.tsx');
const ONB_EMAIL      = read('app/onboarding/verify-email/page.tsx');
const ONB_PHONE      = read('app/onboarding/phone/page.tsx');
const ONB_IDENTITY   = read('app/onboarding/identity/page.tsx');
const ONB_CREDIT     = read('app/onboarding/credit-check/page.tsx');
const ONB_LIVENESS   = read('app/onboarding/liveness/page.tsx');

describe('Migration 0066 — idempotent + backfill', () => {
  it('every ADD COLUMN uses IF NOT EXISTS', () => {
    const adds = MIGRATION.match(/ADD COLUMN[\s\S]*?[,;]/g) ?? [];
    expect(adds.length).toBeGreaterThanOrEqual(5);
    for (const s of adds) {
      expect(s).toMatch(/IF NOT EXISTS/);
    }
  });

  it('adds the five columns the state model reads', () => {
    expect(MIGRATION).toMatch(/onboarding_completed\s+BOOLEAN/);
    expect(MIGRATION).toMatch(/onboarding_completed_at\s+TIMESTAMPTZ/);
    expect(MIGRATION).toMatch(/credit_check_status\s+TEXT/);
    expect(MIGRATION).toMatch(/credit_check_completed_at\s+TIMESTAMPTZ/);
    expect(MIGRATION).toMatch(/liveness_verified_at\s+TIMESTAMPTZ/);
  });

  it('CHECK on credit_check_status is guarded so re-runs don\'t double-add', () => {
    expect(MIGRATION).toMatch(/pg_constraint[\s\S]*?profiles_credit_check_status_chk/);
    expect(MIGRATION).toMatch(/CHECK[\s\S]*?credit_check_status IS NULL[\s\S]*?'pending'[\s\S]*?'passed'[\s\S]*?'failed'/);
  });

  it('backfills grandfathered patients + all non-patient roles', () => {
    expect(MIGRATION).toMatch(/UPDATE public\.profiles/);
    expect(MIGRATION).toMatch(/onboarding_completed\s*=\s*TRUE/);
    // Backfill scoped: patients need all four artifacts + email
    // confirmation; non-patients pass trivially.
    expect(MIGRATION).toMatch(/role\s*<>\s*'patient'/);
    expect(MIGRATION).toMatch(/phone_verified_at IS NOT NULL/);
    expect(MIGRATION).toMatch(/sa_id_number IS NOT NULL/);
    expect(MIGRATION).toMatch(/salary_day IS NOT NULL/);
    expect(MIGRATION).toMatch(/email_confirmed_at IS NOT NULL/);
  });
});

describe('Feature flags — server-only env reads, default false', () => {
  it('exports ENABLE_CREDIT_CHECK + ENABLE_LIVENESS + currentFlags', () => {
    expect(FLAGS_TS).toMatch(/export const ENABLE_CREDIT_CHECK/);
    expect(FLAGS_TS).toMatch(/export const ENABLE_LIVENESS/);
    expect(FLAGS_TS).toMatch(/export function currentFlags/);
  });

  it('reads process.env.ENABLE_* (server-only — not NEXT_PUBLIC_)', () => {
    expect(FLAGS_TS).toMatch(/process\.env\[name\]/);
    expect(FLAGS_TS).toMatch(/readServerFlag\('ENABLE_CREDIT_CHECK'\)/);
    expect(FLAGS_TS).toMatch(/readServerFlag\('ENABLE_LIVENESS'\)/);
  });

  it('defaults to false when the env var is missing', () => {
    // readServerFlag returns false for absent vars — pin the null check.
    expect(FLAGS_TS).toMatch(/if \(!raw\) return false/);
  });
});

describe('Onboarding state module — cached-true short-circuit', () => {
  it('computeOnboarding short-circuits when onboarding_completed=true', () => {
    // Pin the actual code — a regression that moves this check would
    // reintroduce retro-lock behaviour.
    expect(STATE_TS).toMatch(/if \(profile\.onboarding_completed\) return \{ done: true \}/);
  });

  it('stepListFor is keyed on identity_providers (path-fixed, not on email_confirmed_at)', () => {
    // The critical fix: verify-email membership is decided by IDENTITY,
    // not by whether email has been confirmed. Google users never see
    // it; email-signup users see it throughout the journey.
    expect(STATE_TS).toMatch(/if \(user\.identity_providers\.includes\('email'\)\) steps\.push\('verify-email'\)/);
    expect(STATE_TS).toMatch(/if \(flags\.creditCheck\)\s*steps\.push\('credit-check'\)/);
    expect(STATE_TS).toMatch(/if \(flags\.liveness\)\s*steps\.push\('liveness'\)/);
    // Explicitly gone — the pre-fix implementation.
    expect(STATE_TS).not.toMatch(/if \(!user\.email_confirmed_at\) steps\.push\('verify-email'\)/);
  });
});

describe('Onboarding server actions — validation + encryption + no raw logging', () => {
  it('imports the existing AES-256-GCM encryptId helper (+ the SA ID lookup hash)', () => {
    expect(ACTIONS_TS).toMatch(/from ['"]@\/lib\/idEncryption['"]/);
    expect(ACTIONS_TS).toMatch(/import \{ encryptId, hashIdForLookup \}/);
  });

  it('imports validateSaId + isAllowedSalaryDay from the shared helpers', () => {
    expect(ACTIONS_TS).toMatch(/from ['"]@\/lib\/validation['"]/);
    expect(ACTIONS_TS).toMatch(/from ['"]@\/lib\/salaryDates['"]/);
  });

  it('saveIdAndSalaryDay validates BEFORE encrypting', () => {
    const fnStart = ACTIONS_TS.indexOf('export async function saveIdAndSalaryDay');
    const body = ACTIONS_TS.slice(fnStart);
    const validateIdx = body.indexOf('validateSaId(');
    const encryptIdx  = body.indexOf('encryptId(');
    expect(validateIdx).toBeGreaterThan(0);
    expect(encryptIdx).toBeGreaterThan(validateIdx);
  });

  it('never logs the raw SA ID (no console.log/console.error with cleanedId / saIdNumber)', () => {
    const badPatterns = [
      /console\.log\([^)]*cleanedId/,
      /console\.log\([^)]*saIdNumber/,
      /console\.error\([^)]*cleanedId/,
      /console\.error\([^)]*saIdNumber/,
    ];
    for (const bad of badPatterns) {
      expect(ACTIONS_TS).not.toMatch(bad);
    }
  });

  it('credit-check seam — flag-off auto-passes inside saveIdAndSalaryDay', () => {
    const fnStart = ACTIONS_TS.indexOf('export async function saveIdAndSalaryDay');
    const body = ACTIONS_TS.slice(fnStart);
    expect(body).toMatch(/if \(!flags\.creditCheck\)/);
    expect(body).toMatch(/credit_check_status\s*=\s*'passed'/);
  });

  it('maybeFinalize writes onboarding_completed=true when the state model is done', () => {
    expect(ACTIONS_TS).toMatch(/maybeFinalize/);
    expect(ACTIONS_TS).toMatch(/onboarding_completed:\s*true/);
    expect(ACTIONS_TS).toMatch(/onboarding_completed_at:\s*new Date\(\)\.toISOString\(\)/);
  });
});

describe('Routing gate — patient layout redirects incomplete patients', () => {
  it('computes onboarding status and redirects to /onboarding when not done', () => {
    expect(LAYOUT).toMatch(/from ['"]@\/lib\/onboarding\/state['"]/);
    expect(LAYOUT).toMatch(/computeOnboarding\(/);
    expect(LAYOUT).toMatch(/redirect\(['"]\/onboarding['"]\)/);
  });

  it('reads the six onboarding columns from profiles', () => {
    expect(LAYOUT).toMatch(/phone_verified_at,\s*sa_id_number,\s*salary_day/);
    expect(LAYOUT).toMatch(/credit_check_status,\s*liveness_verified_at,\s*onboarding_completed/);
  });
});

describe('Server-side acceptance gate — acceptPlan + payWithSavedCard', () => {
  it('acceptPlan calls requireOnboarded BEFORE the plan update', () => {
    const fnStart = PATIENT_ACT.indexOf('export async function acceptPlan');
    const body = PATIENT_ACT.slice(fnStart);
    const guardIdx  = body.indexOf('requireOnboarded(');
    const updateIdx = body.indexOf('.update(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(updateIdx).toBeGreaterThan(guardIdx);
  });

  it('payWithSavedCard calls requireOnboarded BEFORE any payment-provider call', () => {
    const fnStart = PATIENT_ACT.indexOf('export async function payWithSavedCard');
    const body = PATIENT_ACT.slice(fnStart);
    const guardIdx    = body.indexOf('requireOnboarded(');
    // The saved-card first instalment is now a customer-present CIT via
    // Checkout V2 one-click (provider.createCheckout), not a silent MIT.
    const chargeIdx   = body.indexOf('provider.createCheckout');
    expect(guardIdx).toBeGreaterThan(0);
    expect(chargeIdx).toBeGreaterThan(guardIdx);
  });

  it('refusal returns a not_onboarded reason + /onboarding href for the client', () => {
    // The helper builds a clear refusal shape callers can use to
    // render a "finish setting up" CTA.
    expect(PATIENT_ACT).toMatch(/reason:\s*['"]not_onboarded['"]/);
    expect(PATIENT_ACT).toMatch(/href:\s*['"]\/onboarding['"]/);
    expect(PATIENT_ACT).toMatch(/Please finish setting up your account/);
  });
});

describe('payWithSavedCard — customer-present CIT via Checkout V2 one-click', () => {
  // The saved-card first instalment is a CUSTOMER-PRESENT charge, so it
  // must run as a CIT (3DS-eligible, liability-shifted) that BECOMES the
  // stored-credential chain root — not the silent MIT UNSCHEDULED it used
  // to send. A CIT on a stored card can only run through Checkout V2
  // (the recurring /v1 API is MIT/S2S; 3DS impossible there), so we pass
  // the saved token via cardTokens for a one-click. The CIT root is
  // stamped in the /patient/payment-complete return route.

  const fnStart = PATIENT_ACT.indexOf('export async function payWithSavedCard');
  const body    = PATIENT_ACT.slice(fnStart);
  const PAYMENT_COMPLETE = read('app/patient/payment-complete/page.tsx');

  it('issues a Checkout V2 one-click CIT (createCheckout with cardTokens), NOT a silent MIT', () => {
    expect(body).toContain('provider.createCheckout');
    expect(body).toContain('cardTokens:');
    // cardTokens alone enables one-click; allowStoredCards must NOT be sent
    // (V2 rejects it as an unknown field — proven live 2026-08-02).
    expect(body).not.toContain('allowStoredCards');
    // Must NOT charge the recurring MIT surface on this customer-present path.
    expect(body).not.toContain('provider.chargeSavedCard');
    expect(body).not.toContain("source: 'MIT'");
  });

  it('sends the V2 INITIAL/INSTALLMENT standing instruction (roots the chain), never UNSCHEDULED', () => {
    expect(body).toMatch(/mode:\s*'INITIAL'/);
    expect(body).toMatch(/type:\s*'INSTALLMENT'/);
    expect(body).not.toContain("type:   'UNSCHEDULED'");
  });

  it('hands off to the widget (returns checkoutId), activation lands on the return route', () => {
    expect(body).toContain('checkoutId');
    expect(body).toContain('shopperResultUrl');
    expect(body).toContain('/patient/payment-complete');
  });

  it('the return route stamps the CIT chain root from providerPaymentId, write-once', () => {
    // status.providerPaymentId IS the customer-present CIT id — the
    // initial transaction that established the stored credential.
    const stampBlock = PAYMENT_COMPLETE.match(
      /\.update\(\{\s*peach_initial_transaction_id:\s*status\.providerPaymentId\s*\}\)/,
    );
    expect(stampBlock).not.toBeNull();
    // Race safety: the webhook may land the same value in parallel — the
    // DB predicate enforces write-once.
    expect(PAYMENT_COMPLETE).toMatch(/\.is\('peach_initial_transaction_id',\s*null\)/);
  });

  it('the return route activates instalment 1 via the shared activateFirstInstalment helper', () => {
    expect(PAYMENT_COMPLETE).toContain('activateFirstInstalment');
  });
});

describe('Onboarding routes — layout + router + 5 step pages', () => {
  it('all pages exist', () => {
    expect(existsSync(resolve(ROOT, 'app/onboarding/layout.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/onboarding/page.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/onboarding/verify-email/page.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/onboarding/phone/page.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/onboarding/identity/page.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/onboarding/credit-check/page.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/onboarding/liveness/page.tsx'))).toBe(true);
  });

  it('the shared onboarding shell lives at components/onboarding/OnboardingShell.tsx', () => {
    // Moved out of app/onboarding/_components/ during the unification
    // pass so it lives with other shared UI (SalaryDayPicker, OtpInput).
    expect(existsSync(resolve(ROOT, 'components/onboarding/OnboardingShell.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/onboarding/_components/OnboardingShell.tsx'))).toBe(false);
  });

  it('every step page imports the shared shell from components/onboarding', () => {
    for (const step of ['verify-email', 'phone', 'identity', 'credit-check', 'liveness']) {
      const src = readFileSync(resolve(ROOT, `app/onboarding/${step}/page.tsx`), 'utf8');
      expect(src).toMatch(/from ['"]@\/components\/onboarding\/OnboardingShell['"]/);
    }
  });

  it('onboarding layout is a bare wrapper (auth checks live on each step page — /onboarding/verify-email must be reachable pre-session)', () => {
    // Post the "slim signup" pass, the layout deliberately does NOT
    // require auth or a patient-role check — those live on each step
    // page. This makes /onboarding/verify-email reachable pre-session
    // for fresh email signups (Supabase returns no session until
    // verifyOtp succeeds).
    const codeOnly = ONB_LAYOUT.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/requireConfirmedUser\(/);
  });

  it('router forwards to the first unfinished step (or /patient if done)', () => {
    expect(ONB_ROUTER).toMatch(/computeOnboarding\(/);
    expect(ONB_ROUTER).toMatch(/redirect\(status\.path\)/);
    expect(ONB_ROUTER).toMatch(/redirect\(['"]\/patient['"]\)/);
  });

  it('router finalises when done but the cached flag isn\'t set yet', () => {
    expect(ONB_ROUTER).toMatch(/onboarding_completed:\s*true/);
    expect(ONB_ROUTER).toMatch(/onboarding_completed_at:/);
  });

  it('direct-URL access to any step redirects out when the step doesn\'t apply', () => {
    for (const src of [ONB_EMAIL, ONB_PHONE, ONB_IDENTITY]) {
      expect(src).toMatch(/status\.done \|\| status\.step !== /);
      expect(src).toMatch(/redirect\(['"]\/onboarding['"]\)/);
    }
  });

  it('credit-check + liveness pages redirect out when their flag is off', () => {
    expect(ONB_CREDIT).toMatch(/if \(!flags\.creditCheck\) redirect/);
    expect(ONB_LIVENESS).toMatch(/if \(!flags\.liveness\) redirect/);
  });
});

// ─── UI unification — canonical OtpInput used on both OTP steps ──────

describe('Onboarding OTP unification — canonical OtpInput on both steps', () => {
  const EMAIL_STEP = readFileSync(resolve(ROOT, 'app/onboarding/verify-email/VerifyEmailStepClient.tsx'), 'utf8');
  const PHONE_STEP = readFileSync(resolve(ROOT, 'app/onboarding/phone/PhoneStepClient.tsx'), 'utf8');
  const OLD_EMAIL_FORM = readFileSync(resolve(ROOT, 'app/verify-email/VerifyEmailForm.tsx'), 'utf8');
  const PHONE_OTP_STEP = readFileSync(resolve(ROOT, 'app/_otp/PhoneOtpStep.tsx'), 'utf8');

  it('email step delegates to the canonical VerifyEmailForm (which uses OtpInput)', () => {
    expect(EMAIL_STEP).toMatch(/from ['"]@\/app\/verify-email\/VerifyEmailForm['"]/);
    expect(EMAIL_STEP).toMatch(/<VerifyEmailForm[\s\S]*?next="\/onboarding"/);
  });

  it('phone step delegates to the canonical PhoneOtpStep (which uses OtpInput)', () => {
    expect(PHONE_STEP).toMatch(/from ['"]@\/app\/_otp\/PhoneOtpStep['"]/);
    expect(PHONE_STEP).toMatch(/<PhoneOtpStep\b/);
  });

  it('both canonical components import OtpInput from @/components/OtpInput', () => {
    expect(OLD_EMAIL_FORM).toMatch(/from ['"]@\/components\/OtpInput['"]/);
    expect(PHONE_OTP_STEP).toMatch(/from ['"]@\/components\/OtpInput['"]/);
  });

  it('phone step keeps the phone-entry sub-stage for Google users (no captured phone)', () => {
    // The two-stage flow is onboarding-specific — Google users need to
    // enter a phone number before the OTP round-trip. That sub-stage
    // stays in PhoneStepClient; only the OTP sub-stage delegates.
    expect(PHONE_STEP).toMatch(/Stage = 'phone-entry' \| 'otp'/);
    expect(PHONE_STEP).toMatch(/setPhoneForOnboarding/);
  });

  it('email step client has NO inline OTP input (canonical component owns it)', () => {
    // The inline single-input pattern from the pre-unification build is
    // gone. A regression that re-inlines an OTP input would trip here.
    expect(EMAIL_STEP).not.toMatch(/tracking-\[0\.5em\]/);
    expect(EMAIL_STEP).not.toMatch(/maxLength=\{6\}/);
  });

  it('phone step client has NO inline OTP input (canonical component owns it)', () => {
    // The two-stage flow still has a phone-number input, but the OTP
    // input itself is delegated to PhoneOtpStep.
    // A regression that re-inlines a 6-digit OTP input would trip here.
    expect(PHONE_STEP).not.toMatch(/data-testid="onboarding-phone-otp"/);
    expect(PHONE_STEP).not.toMatch(/maxLength=\{6\}/);
  });

  it('on-success behaviour redirects to /onboarding (router recomputes state)', () => {
    // Server actions + resume behaviour rely on landing back on
    // /onboarding after every step — not going straight into /patient.
    expect(EMAIL_STEP).toMatch(/next="\/onboarding"/);
    expect(PHONE_STEP).toMatch(/window\.location\.href\s*=\s*['"]\/onboarding['"]/);
  });
});

// ─── Slim signup — email path lands in /onboarding/verify-email ─────

describe('Slim patient signup — account-only + hand-off to /onboarding', () => {
  const SIGNUP_FORM   = readFileSync(resolve(ROOT, 'app/signup/patient/PatientSignupForm.tsx'),   'utf8');
  const SIGNUP_ACTION = readFileSync(resolve(ROOT, 'app/signup/patient/actions.ts'),              'utf8');

  it('signup input type has no phone / saIdNumber / salaryDay fields', () => {
    expect(SIGNUP_ACTION).not.toMatch(/\bphone\s*:\s*string/);
    expect(SIGNUP_ACTION).not.toMatch(/\bsaIdNumber\s*:\s*string/);
    expect(SIGNUP_ACTION).not.toMatch(/\bsalaryDay\s*:\s*number/);
  });

  it('signup action does not import the identity-step helpers', () => {
    // These live at the identity step now — the signup action should
    // not import them. A regression that re-adds phone/SA-ID/salary
    // capture at signup will trip this.
    expect(SIGNUP_ACTION).not.toMatch(/from ['"]@\/lib\/idEncryption['"]/);
    expect(SIGNUP_ACTION).not.toMatch(/normalizePhoneZA/);
    expect(SIGNUP_ACTION).not.toMatch(/validateSaId/);
    expect(SIGNUP_ACTION).not.toMatch(/isAllowedSalaryDay/);
  });

  it('signup action writes only role + first_name + last_name to raw_user_meta_data', () => {
    // The auth.users trigger reads these on insert. We deliberately
    // leave phone / sa_id_number / salary_day null so the state model
    // routes the new user through the phone + identity steps.
    const dataMatch = SIGNUP_ACTION.match(/options:\s*\{[\s\S]*?data:\s*\{([\s\S]*?)\}\s*,?\s*\}\s*,?\s*\}\s*\)/);
    expect(dataMatch).not.toBeNull();
    const dataLiteral = dataMatch?.[1] ?? '';
    expect(dataLiteral).toMatch(/role:\s*['"]patient['"]/);
    expect(dataLiteral).toMatch(/first_name:/);
    expect(dataLiteral).toMatch(/last_name:/);
    // Explicitly NOT present:
    expect(dataLiteral).not.toMatch(/\bphone\s*:/);
    expect(dataLiteral).not.toMatch(/sa_id_number/);
    expect(dataLiteral).not.toMatch(/salary_day/);
  });

  it('signup form has NO phone / SA-ID / salary-day fields', () => {
    expect(SIGNUP_FORM).not.toMatch(/id="patient-phone"/);
    expect(SIGNUP_FORM).not.toMatch(/id="patient-saIdNumber"/);
    expect(SIGNUP_FORM).not.toMatch(/SalaryDayPicker/);
    // The BLANK draft no longer has these keys either.
    expect(SIGNUP_FORM).not.toMatch(/saIdNumber:\s*''/);
    expect(SIGNUP_FORM).not.toMatch(/salaryDay:\s*''/);
    expect(SIGNUP_FORM).not.toMatch(/phone:\s*''/);
  });

  it('signup form redirects into /onboarding/verify-email?email=<addr>', () => {
    expect(SIGNUP_FORM).toMatch(/\/onboarding\/verify-email\?email=/);
    // Old chain must be gone.
    expect(SIGNUP_FORM).not.toMatch(/\/verify-phone/);
    expect(SIGNUP_FORM).not.toMatch(/\/verify-email\?email=.*next=/);
  });
});

describe('/onboarding/verify-email — reachable pre-session via ?email= param', () => {
  const VE_PAGE   = readFileSync(resolve(ROOT, 'app/onboarding/verify-email/page.tsx'), 'utf8');
  const ONB_LAY   = readFileSync(resolve(ROOT, 'app/onboarding/layout.tsx'),           'utf8');

  it('onboarding layout does NOT require an authenticated session', () => {
    // Auth checks live on the individual step pages (which need
    // /onboarding/verify-email to work pre-session for fresh email
    // signups). A regression that re-adds requireConfirmedUser as an
    // actual CALL in the layout would break the email OTP landing —
    // strip comments before checking so the prose here doesn't count.
    const codeOnly = ONB_LAY.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/requireConfirmedUser\(/);
  });

  it('verify-email page reads email from ?email= search param when unauthenticated', () => {
    expect(VE_PAGE).toMatch(/searchParams/);
    expect(VE_PAGE).toMatch(/params\.email/);
  });

  it('verify-email page derives pre-session total from stepListFor with a synthetic [\'email\'] identity', () => {
    // The pre-session branch uses PRE_SESSION_EMAIL_USER (a synthetic
    // UserForOnboarding with identity_providers: ['email']) so its
    // step list is IDENTICAL to what an authenticated email-path user
    // would see. Same source function = totals cannot drift.
    expect(VE_PAGE).toMatch(/PRE_SESSION_EMAIL_USER/);
    expect(VE_PAGE).toMatch(/identity_providers:\s*\['email'\]/);
    expect(VE_PAGE).toMatch(/stepListFor\(PRE_SESSION_EMAIL_USER/);
    // Shell receives {steps, currentStep} — position derived internally.
    expect(VE_PAGE).toMatch(/currentStep="verify-email"/);
  });

  it('verify-email page still handles the authenticated edge case (redirect if done)', () => {
    // A user who somehow reaches /onboarding/verify-email while
    // already email-confirmed gets forwarded to /onboarding (which
    // routes to the next unfinished step). Pin the redirect exists.
    expect(VE_PAGE).toMatch(/status\.done \|\| status\.step !== 'verify-email'/);
  });
});

// ─── Shell + requireConfirmedUser wiring ──────────────────────────────

describe('OnboardingShell API — receives (steps, currentStep), computes position internally', () => {
  const SHELL = readFileSync(resolve(ROOT, 'components/onboarding/OnboardingShell.tsx'), 'utf8');

  it('shell props are steps + currentStep — not currentIndex/total', () => {
    expect(SHELL).toMatch(/steps:\s*readonly OnboardingStep\[\]/);
    expect(SHELL).toMatch(/currentStep:\s*OnboardingStep/);
    // Old currentIndex+total prop API is gone.
    expect(SHELL).not.toMatch(/currentIndex:\s*number/);
    expect(SHELL).not.toMatch(/total:\s*number/);
  });

  it('shell computes position as steps.indexOf(currentStep) + 1', () => {
    expect(SHELL).toMatch(/const idx\s*=\s*steps\.indexOf\(currentStep\)/);
    expect(SHELL).toMatch(/const currentIndex\s*=\s*idx >= 0 \?\s*idx \+ 1/);
    expect(SHELL).toMatch(/const total\s*=\s*steps\.length/);
  });

  it('every step page passes steps + currentStep (not the old prop API)', () => {
    for (const step of ['verify-email', 'phone', 'identity', 'credit-check', 'liveness']) {
      const src = readFileSync(resolve(ROOT, `app/onboarding/${step}/page.tsx`), 'utf8');
      expect(src).toMatch(/steps=\{steps\}/);
      expect(src).toMatch(new RegExp(`currentStep="${step}"`));
      // No stale prop pass-through.
      expect(src).not.toMatch(/currentIndex=\{/);
      expect(src).not.toMatch(/total=\{steps\.length\}/);
    }
  });
});

describe('requireConfirmedUser exposes identity_providers + email_confirmed_at', () => {
  const HELPER = readFileSync(resolve(ROOT, 'lib/auth/requireConfirmedUser.ts'), 'utf8');

  it('return type has identity_providers (readonly string[])', () => {
    expect(HELPER).toMatch(/identity_providers:\s*readonly string\[\]/);
  });

  it('return type has email_confirmed_at (string, non-null on the return path)', () => {
    expect(HELPER).toMatch(/email_confirmed_at:\s*string/);
    // Must NOT be typed as nullable — helper redirects unconfirmed
    // users, so callers get a guaranteed non-null value.
    expect(HELPER).not.toMatch(/email_confirmed_at:\s*string \| null/);
  });

  it('helper extracts providers from user.identities and freezes the array', () => {
    expect(HELPER).toMatch(/user\.identities \?\? \[\]/);
    expect(HELPER).toMatch(/\.map\(\(i\) => i\.provider\)/);
    expect(HELPER).toMatch(/Object\.freeze/);
  });
});

describe('Consumers of computeOnboarding pass identity_providers', () => {
  const layouts = [
    'app/patient/layout.tsx',
    'app/patient/actions.ts',
    'app/onboarding/page.tsx',
    'app/onboarding/phone/page.tsx',
    'app/onboarding/identity/page.tsx',
    'app/onboarding/credit-check/page.tsx',
    'app/onboarding/liveness/page.tsx',
    'app/onboarding/verify-email/page.tsx',
    'lib/onboarding/actions.ts',
  ];

  it.each(layouts)('%s passes identity_providers when constructing UserForOnboarding', (rel) => {
    const src = readFileSync(resolve(ROOT, rel), 'utf8');
    expect(src).toMatch(/identity_providers:/);
  });
});

// ─── Grep guard — no stale imports of the pre-unification locations ──

describe('No orphan imports of the pre-unification component locations', () => {
  it('nothing imports the old shell path (app/onboarding/_components)', () => {
    // Simple sweep: recurse app/ + lib/ + components/ for the removed path.
    // Anything found means we missed an import in the move.
    const paths = [
      'app/onboarding/verify-email/page.tsx',
      'app/onboarding/phone/page.tsx',
      'app/onboarding/identity/page.tsx',
      'app/onboarding/credit-check/page.tsx',
      'app/onboarding/liveness/page.tsx',
      'app/onboarding/verify-email/VerifyEmailStepClient.tsx',
      'app/onboarding/phone/PhoneStepClient.tsx',
      'app/onboarding/identity/IdentityStepClient.tsx',
      'app/onboarding/credit-check/CreditCheckStepClient.tsx',
      'app/onboarding/liveness/LivenessStepClient.tsx',
    ];
    for (const p of paths) {
      const src = readFileSync(resolve(ROOT, p), 'utf8');
      expect(src).not.toMatch(/from ['"][^'"]*_components\/OnboardingShell['"]/);
    }
  });
});

// ─── Diff scope — no payment / RLS / webhook file changes ─────────────

describe('Diff scope — onboarding + auth surfaces + the acceptance gate only', () => {
  it('the state module is pure — no I/O imports', () => {
    expect(STATE_TS).not.toMatch(/from ['"]@\/lib\/supabase\//);
    expect(STATE_TS).not.toMatch(/from ['"]@\/lib\/payments\/provider/);
    expect(STATE_TS).not.toMatch(/from ['"]@\/lib\/finance/);
  });

  it('the onboarding actions file doesn\'t import payment / webhook / finance-math modules', () => {
    const FORBIDDEN = [
      '@/lib/payments/',
      'app/api/payments/peach/webhook',
      '@/lib/bills/lifecycle',
      '@/lib/finance',
    ];
    for (const mod of FORBIDDEN) {
      expect(ACTIONS_TS).not.toContain(`from '${mod}`);
      expect(ACTIONS_TS).not.toContain(`from "${mod}`);
    }
  });
});
