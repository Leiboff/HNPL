import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DRAFT_EXPIRY_DAYS,
  ONBOARDING_ADVANCE_COOKIE,
  isDraftExpired,
  maskEmail,
  maskPhone,
} from '@/lib/onboarding/draft';

// ─── Resumable-draft resume gate ────────────────────────────────────────
//
// Two halves:
//   • Pure-function unit tests over isDraftExpired / maskEmail / maskPhone.
//   • Source-text pins on the router (app/onboarding/page.tsx), the
//     actions file, and the interstitial component — mirroring the style
//     of lib/onboarding/onboarding-state.test.ts so a regression that
//     silently reintroduces auto-resume (or drops the 30-day expiry, or
//     the shared-device identity display) trips a test.

describe('isDraftExpired', () => {
  const NOW = new Date('2026-08-09T12:00:00Z');

  it('null lastActiveAt is never expired (no draft exists yet)', () => {
    expect(isDraftExpired(null, NOW)).toBe(false);
  });

  it('exactly at the boundary is not yet expired', () => {
    const boundary = new Date(NOW.getTime() - DRAFT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(isDraftExpired(boundary, NOW)).toBe(false);
  });

  it('one second past 30 days is expired', () => {
    const justOver = new Date(NOW.getTime() - (DRAFT_EXPIRY_DAYS * 24 * 60 * 60 * 1000 + 1000)).toISOString();
    expect(isDraftExpired(justOver, NOW)).toBe(true);
  });

  it('a draft touched an hour ago is not expired', () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    expect(isDraftExpired(recent, NOW)).toBe(false);
  });
});

describe('maskEmail', () => {
  it('masks a normal local part to first+last char', () => {
    expect(maskEmail('jane.smith@example.com')).toBe('j********h@example.com');
  });

  it('never returns the raw email unmasked', () => {
    const email = 'patient@betternow.co.za';
    const masked = maskEmail(email);
    expect(masked).not.toBe(email);
    expect(masked).not.toBeNull();
  });

  it('short local parts collapse to one visible leading character', () => {
    expect(maskEmail('jo@example.com')).toBe('j***@example.com');
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  it('null/undefined/no-domain input returns null, never throws', () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail('not-an-email')).toBeNull();
  });
});

describe('maskPhone', () => {
  it('shows only the last 4 digits', () => {
    expect(maskPhone('+27821234567')).toBe('•••• 4567');
    expect(maskPhone('0821234567')).toBe('•••• 4567');
  });

  it('never returns the full number unmasked', () => {
    const phone = '0821234567';
    expect(maskPhone(phone)).not.toContain('082123');
  });

  it('null/undefined/too-short input returns null, never throws', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
    expect(maskPhone('12')).toBeNull();
  });
});

// ─── Source-text pins ────────────────────────────────────────────────

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const MIGRATION   = read('supabase/migrations/0085_onboarding_draft_resume.sql');
const ROUTER       = read('app/onboarding/page.tsx');
const ACTIONS_TS   = read('lib/onboarding/actions.ts');
const PHONE_STEP   = read('app/onboarding/phone/PhoneStepClient.tsx');
const INTERSTITIAL = read('components/onboarding/WelcomeBackInterstitial.tsx');

describe('Migration 0085 — idempotent single-column add', () => {
  it('adds onboarding_last_active_at with IF NOT EXISTS', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS onboarding_last_active_at\s+TIMESTAMPTZ/);
  });
});

describe('Router — never silently forwards into an existing in-progress draft', () => {
  it('reads onboarding_last_active_at + email + phone alongside the existing step columns', () => {
    expect(ROUTER).toMatch(/onboarding_last_active_at/);
    expect(ROUTER).toMatch(/select\('role, email, phone,/);
  });

  it('a brand-new draft (lastActiveAt null) stamps the clock and proceeds WITHOUT the interstitial', () => {
    const idx = ROUTER.indexOf('lastActiveAt === null');
    expect(idx).toBeGreaterThan(0);
    const body = ROUTER.slice(idx, idx + 600);
    expect(body).toMatch(/onboarding_last_active_at:\s*new Date\(\)\.toISOString\(\)/);
    expect(body).toMatch(/redirect\(status\.path\)/);
  });

  it('reads the short-lived advance cookie to detect a direct step-to-step continuation', () => {
    expect(ROUTER).toMatch(/from ['"]@\/lib\/onboarding\/draft['"]/);
    expect(ROUTER).toMatch(/ONBOARDING_ADVANCE_COOKIE/);
    expect(ROUTER).toMatch(/cookieStore\.get\(ONBOARDING_ADVANCE_COOKIE\)\?\.value === user\.id/);
  });

  it('an existing draft with NO advance signal renders the WelcomeBackInterstitial — never an unconditional redirect(status.path) as the last statement', () => {
    expect(ROUTER).toMatch(/from ['"]@\/components\/onboarding\/WelcomeBackInterstitial['"]/);
    expect(ROUTER).toMatch(/<WelcomeBackInterstitial/);
    // The interstitial branch must be reachable — i.e. it isn't dead code
    // behind an early, unconditional redirect. Both redirect(status.path)
    // call sites are guarded by an `if` immediately above them.
    const interstitialIdx = ROUTER.indexOf('<WelcomeBackInterstitial');
    const lastRedirectIdx = ROUTER.lastIndexOf('redirect(status.path)');
    expect(interstitialIdx).toBeGreaterThan(lastRedirectIdx);
  });

  it('passes the 30-day expiry + masked identity into the interstitial — never the raw email/phone', () => {
    expect(ROUTER).toMatch(/expired=\{isDraftExpired\(lastActiveAt\)\}/);
    expect(ROUTER).toMatch(/maskedEmail=\{maskEmail\(/);
    expect(ROUTER).toMatch(/maskedPhone=\{profile\.phone_verified_at \? maskPhone\(/);
    expect(ROUTER).not.toMatch(/maskedEmail=\{profile\.email\}/);
  });

  it('still finalises onboarding_completed the same way as before (regression pin, unchanged)', () => {
    expect(ROUTER).toMatch(/onboarding_completed:\s*true/);
    expect(ROUTER).toMatch(/onboarding_completed_at:/);
    expect(ROUTER).toMatch(/redirect\(['"]\/patient['"]\)/);
  });
});

describe('Actions — draft activity stamping + resume actions never bypass identity', () => {
  it('touchDraftActivity bumps onboarding_last_active_at AND sets the advance cookie', () => {
    const idx = ACTIONS_TS.indexOf('async function touchDraftActivity');
    expect(idx).toBeGreaterThan(0);
    const body = ACTIONS_TS.slice(idx, idx + 500);
    expect(body).toMatch(/onboarding_last_active_at:\s*new Date\(\)\.toISOString\(\)/);
    expect(body).toMatch(/markOnboardingAdvance\(userId\)/);
  });

  it('maybeFinalize calls touchDraftActivity for every step write', () => {
    const idx = ACTIONS_TS.indexOf('async function maybeFinalize');
    const body = ACTIONS_TS.slice(idx, idx + 300);
    expect(body).toMatch(/touchDraftActivity\(userId\)/);
  });

  it('the advance cookie is httpOnly (never readable by client JS — server-side only)', () => {
    const idx = ACTIONS_TS.indexOf('function markOnboardingAdvance');
    const body = ACTIONS_TS.slice(idx, idx + 400);
    expect(body).toMatch(/httpOnly:\s*true/);
  });

  it('continueOnboardingDraft re-authenticates via loadUserAndProfile before resuming anything', () => {
    const idx = ACTIONS_TS.indexOf('export async function continueOnboardingDraft');
    expect(idx).toBeGreaterThan(0);
    const body = ACTIONS_TS.slice(idx, idx + 700);
    expect(body).toMatch(/loadUserAndProfile\(\)/);
    expect(body).toMatch(/computeOnboarding\(/);
  });

  it('continueOnboardingDraft refuses server-side when the draft is expired (not just a hidden button)', () => {
    const idx = ACTIONS_TS.indexOf('export async function continueOnboardingDraft');
    const body = ACTIONS_TS.slice(idx, idx + 700);
    expect(body).toMatch(/isDraftExpired\(loaded\.onboardingLastActiveAt\)/);
    expect(body).toMatch(/return \{ error:/);
  });

  it('startOverOnboardingDraft clears only the draft fields — never terms/privacy acceptance', () => {
    const idx = ACTIONS_TS.indexOf('export async function startOverOnboardingDraft');
    expect(idx).toBeGreaterThan(0);
    const body = ACTIONS_TS.slice(idx, idx + 900);
    expect(body).toMatch(/phone:\s*null/);
    expect(body).toMatch(/phone_verified_at:\s*null/);
    expect(body).toMatch(/sa_id_number:\s*null/);
    expect(body).toMatch(/salary_day:\s*null/);
    expect(body).toMatch(/credit_check_status:\s*null/);
    expect(body).toMatch(/liveness_verified_at:\s*null/);
    expect(body).toMatch(/onboarding_last_active_at:\s*now/);
    expect(body).not.toMatch(/terms_accepted_at/);
    expect(body).not.toMatch(/terms_version/);
    expect(body).not.toMatch(/privacy_version/);
  });

  it('start-over does not touch the credit-check / liveness INTEGRATION logic (runCreditCheck/runLiveness untouched)', () => {
    expect(ACTIONS_TS).toMatch(/export async function runCreditCheck/);
    expect(ACTIONS_TS).toMatch(/export async function runLiveness/);
    // The stub bodies are unchanged from the pre-resume version — still
    // a single UPDATE to credit_check_status / liveness_verified_at with
    // no branching on draft state.
    const creditIdx = ACTIONS_TS.indexOf('export async function runCreditCheck');
    const creditBody = ACTIONS_TS.slice(creditIdx, ACTIONS_TS.indexOf('export async function runLiveness'));
    expect(creditBody).not.toMatch(/startOverOnboardingDraft|continueOnboardingDraft/);
  });
});

describe('Phone step — advances the draft clock without touching OTP verification logic', () => {
  it('onVerified calls refreshOnboardingState before navigating, still lands on /onboarding', () => {
    expect(PHONE_STEP).toMatch(/await refreshOnboardingState\(\)/);
    expect(PHONE_STEP).toMatch(/window\.location\.href\s*=\s*['"]\/onboarding['"]/);
  });

  it('does not import or call verifyPhoneOtpForUser differently — the OTP RPC itself is untouched', () => {
    expect(PHONE_STEP).toMatch(/verifyPhoneOtpForUser/);
    // No new params threaded into the OTP verify call.
    expect(PHONE_STEP).not.toMatch(/verifyPhoneOtpForUser\([^)]+\)/);
  });
});

describe('WelcomeBackInterstitial — explicit confirmation, never auto-acts', () => {
  it('renders a masked identity block, not the raw email/phone', () => {
    expect(INTERSTITIAL).toMatch(/maskedEmail/);
    expect(INTERSTITIAL).toMatch(/maskedPhone/);
    expect(INTERSTITIAL).not.toMatch(/profile\.email/);
  });

  it('expired drafts hide the Continue button — Start over is the only action', () => {
    const idx = INTERSTITIAL.indexOf("{!expired && (");
    expect(idx).toBeGreaterThan(0);
    const continueBlock = INTERSTITIAL.slice(idx, idx + 400);
    expect(continueBlock).toMatch(/onboarding-resume-continue/);
  });

  it('both actions require an explicit button click — no useEffect auto-continue on mount', () => {
    expect(INTERSTITIAL).not.toMatch(/useEffect/);
  });

  it('calls the server actions by name (continueOnboardingDraft / startOverOnboardingDraft)', () => {
    expect(INTERSTITIAL).toMatch(/from ['"]@\/lib\/onboarding\/actions['"]/);
    expect(INTERSTITIAL).toMatch(/continueOnboardingDraft/);
    expect(INTERSTITIAL).toMatch(/startOverOnboardingDraft/);
  });
});

describe('Cookie name is exported once and reused (no duplicated string literal)', () => {
  it('draft.ts is the single source of the cookie name', () => {
    expect(ONBOARDING_ADVANCE_COOKIE).toBe('hnpl_onboarding_advance');
  });

  it('actions.ts and the router both import it rather than inlining the string', () => {
    expect(ACTIONS_TS).toMatch(/from ['"]\.\/draft['"]/);
    expect(ROUTER).toMatch(/from ['"]@\/lib\/onboarding\/draft['"]/);
    expect(ACTIONS_TS).not.toMatch(/'hnpl_onboarding_advance'/);
    expect(ROUTER).not.toMatch(/'hnpl_onboarding_advance'/);
  });
});
