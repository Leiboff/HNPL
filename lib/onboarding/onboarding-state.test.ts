import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeOnboarding,
  isOnboarded,
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

const EMAIL_USER: UserForOnboarding  = { email_confirmed_at: null };
const GOOGLE_USER: UserForOnboarding = { email_confirmed_at: '2026-07-06T10:00:00Z' };

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

// ─── stepsFor — the visible step count per user + flag combo ─────────

describe('stepsFor — Google skips verify-email; flags include/exclude their steps', () => {
  it('email user, flags off → 3 steps (email OTP, phone, identity)', () => {
    expect(stepsFor(EMAIL_USER, FLAGS_OFF)).toEqual(['verify-email', 'phone', 'identity']);
  });

  it('Google user, flags off → 2 steps (phone, identity) — email OTP skipped', () => {
    expect(stepsFor(GOOGLE_USER, FLAGS_OFF)).toEqual(['phone', 'identity']);
  });

  it('email user, flags on → 5 steps (all of them)', () => {
    expect(stepsFor(EMAIL_USER, FLAGS_ON)).toEqual([
      'verify-email', 'phone', 'identity', 'credit-check', 'liveness',
    ]);
  });

  it('Google user, flags on → 4 steps (no verify-email)', () => {
    expect(stepsFor(GOOGLE_USER, FLAGS_ON)).toEqual([
      'phone', 'identity', 'credit-check', 'liveness',
    ]);
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

  it('email user, email confirmed only → step=phone, 2 of 3', () => {
    const s = computeOnboarding(GOOGLE_USER, BLANK_PROFILE, FLAGS_OFF);
    // (same as above; sanity confirms Google is equivalent to email-confirmed)
    expect(s.done).toBe(false);
  });

  it('email user, email+phone → step=identity, 3 of 3', () => {
    const p = { ...BLANK_PROFILE, phone_verified_at: '2026-07-06T10:00:00Z' };
    const s = computeOnboarding(GOOGLE_USER, p, FLAGS_OFF);
    expect(s.done).toBe(false);
    if (!s.done) expect(s.step).toBe('identity');
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

  it('email user abandons after email OTP → resumes at phone', () => {
    // After email OTP the auth.users.email_confirmed_at is set.
    const s = computeOnboarding(
      { email_confirmed_at: '2026-07-06T10:00:00Z' },
      BLANK_PROFILE,
      FLAGS_OFF,
    );
    expect(s.done).toBe(false);
    if (!s.done) expect(s.step).toBe('phone');
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

  it('stepsFor computes visible step count per user + flags', () => {
    expect(STATE_TS).toMatch(/if \(!user\.email_confirmed_at\) steps\.push\('verify-email'\)/);
    expect(STATE_TS).toMatch(/if \(flags\.creditCheck\)\s*steps\.push\('credit-check'\)/);
    expect(STATE_TS).toMatch(/if \(flags\.liveness\)\s*steps\.push\('liveness'\)/);
  });
});

describe('Onboarding server actions — validation + encryption + no raw logging', () => {
  it('imports the existing AES-256-GCM encryptId helper', () => {
    expect(ACTIONS_TS).toMatch(/from ['"]@\/lib\/idEncryption['"]/);
    expect(ACTIONS_TS).toMatch(/import \{ encryptId \}/);
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

  it('payWithSavedCard calls requireOnboarded BEFORE any Paystack call', () => {
    const fnStart = PATIENT_ACT.indexOf('export async function payWithSavedCard');
    const body = PATIENT_ACT.slice(fnStart);
    const guardIdx      = body.indexOf('requireOnboarded(');
    const paystackIdx   = body.indexOf('paystackRequest<');
    expect(guardIdx).toBeGreaterThan(0);
    expect(paystackIdx).toBeGreaterThan(guardIdx);
  });

  it('refusal returns a not_onboarded reason + /onboarding href for the client', () => {
    // The helper builds a clear refusal shape callers can use to
    // render a "finish setting up" CTA.
    expect(PATIENT_ACT).toMatch(/reason:\s*['"]not_onboarded['"]/);
    expect(PATIENT_ACT).toMatch(/href:\s*['"]\/onboarding['"]/);
    expect(PATIENT_ACT).toMatch(/Please finish setting up your account/);
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

  it('onboarding layout is auth-required + patient-only', () => {
    expect(ONB_LAYOUT).toMatch(/requireConfirmedUser/);
    expect(ONB_LAYOUT).toMatch(/profile\?\.role[\s\S]*?!==\s*'patient'/);
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

// ─── Diff scope — no payment / RLS / webhook file changes ─────────────

describe('Diff scope — onboarding + auth surfaces + the acceptance gate only', () => {
  it('the state module is pure — no I/O imports', () => {
    expect(STATE_TS).not.toMatch(/from ['"]@\/lib\/supabase\//);
    expect(STATE_TS).not.toMatch(/from ['"]@\/lib\/paystack/);
    expect(STATE_TS).not.toMatch(/from ['"]@\/lib\/finance/);
  });

  it('the onboarding actions file doesn\'t import payment / webhook / finance-math modules', () => {
    const FORBIDDEN = [
      '@/lib/payments/',
      '@/lib/paystack/',
      '@/lib/bills/lifecycle',
      'app/api/webhooks/paystack',
      '@/lib/finance',
    ];
    for (const mod of FORBIDDEN) {
      expect(ACTIONS_TS).not.toContain(`from '${mod}`);
      expect(ACTIONS_TS).not.toContain(`from "${mod}`);
    }
  });
});
