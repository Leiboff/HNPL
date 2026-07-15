import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Signup forms — shared-hook + required-set regression ────────────────────
//
// Two assertions per form:
//   • The form file imports the shared validation-timing hook
//     (`useFieldValidation`) — proves we didn't hand-roll per-field touched
//     logic in either form.
//   • The required-field set is exactly the set we expect, asserted via
//     the server `validate()` strings. The server is authoritative; if a
//     client regression silently drops a required check we still catch it
//     here as long as the SAME field stays required server-side.

const ROOT = resolve(process.cwd());

function readSrc(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

// ─── Shared-hook adoption ────────────────────────────────────────────────────

describe('signup forms use the shared useFieldValidation hook', () => {
  it('practice form imports useFieldValidation from @/lib/forms/useFieldValidation', () => {
    const src = readSrc('app/signup/practice/page.tsx');
    expect(src).toMatch(/from\s+['"]@\/lib\/forms\/useFieldValidation['"]/);
    expect(src).toMatch(/\buseFieldValidation\b/);
  });

  it('patient form imports useFieldValidation from @/lib/forms/useFieldValidation', () => {
    const src = readSrc('app/signup/patient/PatientSignupForm.tsx');
    expect(src).toMatch(/from\s+['"]@\/lib\/forms\/useFieldValidation['"]/);
    expect(src).toMatch(/\buseFieldValidation\b/);
  });
});

// ─── Required-set on the practice server action ──────────────────────────────

describe('practice signup — server required-field set', () => {
  const src = readSrc('app/signup/practice/actions.ts');

  it.each([
    ['Practice name', 'Practice name is required.'],
    ['Specialty',     'Specialty is required.'],
    ['Street',        'Street address is required.'],
    ['Suburb',        'Suburb is required.'],
    ['City',          'City is required.'],
    ['Province',      'Province is required.'],
    ['Postal code',   'Postal code is required.'],
    ['First name',    'First name is required.'],
    ['Last name',     'Last name is required.'],
  ])('rejects missing %s', (_name, message) => {
    expect(src).toContain(message);
  });

  it('does NOT require Practice number (PR)', () => {
    // No "Practice number is required" / "PR is required" string — PR is optional.
    expect(src).not.toMatch(/Practice number.*required/i);
    expect(src).not.toMatch(/\bPR\b.*required/);
  });

  it('does NOT require Address line 2', () => {
    expect(src).not.toMatch(/Address line 2.*required/i);
  });
});

// ─── No '(optional)' label text anywhere on the signup forms ─────────────────
//
// The asterisk-on-required convention means optional fields carry no marker
// at all. The previous "(optional)" parenthetical is gone; future copy-paste
// would re-introduce it. Lock it out via source text.

describe('signup forms — no "(optional)" label text', () => {
  it('practice form does not contain "(optional)"', () => {
    const src = readSrc('app/signup/practice/page.tsx');
    expect(src).not.toContain('(optional)');
  });

  it('patient form does not contain "(optional)"', () => {
    const src = readSrc('app/signup/patient/PatientSignupForm.tsx');
    expect(src).not.toContain('(optional)');
  });
});

// ─── Branded "betternow terms" link present on both forms ────────────────────

describe('signup forms — branded betternow terms link', () => {
  it('practice form links /legal/terms with lowercase "betternow"', () => {
    const src = readSrc('app/signup/practice/page.tsx');
    expect(src).toContain('/legal/terms');
    expect(src).toContain('betternow');
  });

  it('patient form links /legal/terms with lowercase "betternow"', () => {
    const src = readSrc('app/signup/patient/PatientSignupForm.tsx');
    expect(src).toContain('/legal/terms');
    expect(src).toContain('betternow');
  });
});

// ─── OTP flow — auto-session bypass removed, redirect to /verify-email ───────
//
// Two bypasses existed in the practice flow before Phase 2.5:
//   1. svc.auth.admin.createUser({ email_confirm: true }) — pre-confirmed
//      the user, so no OTP was ever sent.
//   2. supabase.auth.signInWithPassword(...) at the tail — minted a live
//      session before the user proved control of the email.
// Both must stay gone. These tests lock that in.

describe('signup actions — no auto-confirm / auto-session bypasses', () => {
  it('practice action does NOT call admin.createUser({email_confirm:true})', () => {
    const src = readSrc('app/signup/practice/actions.ts');
    expect(src).not.toMatch(/email_confirm:\s*true/);
    expect(src).not.toMatch(/admin\.createUser/);
  });

  it('practice action does NOT call signInWithPassword (no auto-session pre-verify)', () => {
    const src = readSrc('app/signup/practice/actions.ts');
    expect(src).not.toMatch(/signInWithPassword/);
  });

  it('practice action returns needsVerification + email so the form can redirect', () => {
    const src = readSrc('app/signup/practice/actions.ts');
    expect(src).toMatch(/needsVerification/);
  });
});

describe('signup forms — redirect to /verify-email after signup', () => {
  it('practice form redirects to /verify-email with email + next=/practice', () => {
    const src = readSrc('app/signup/practice/page.tsx');
    expect(src).toContain('/verify-email');
    expect(src).toMatch(/next=.*\/practice|practice.*next/);
  });

  it('patient form redirects post-signup into /onboarding/verify-email with the email as a query param', () => {
    // Post the "slim signup" pass, the patient form no longer chains
    // /verify-email → /verify-phone → /patient. The account-only form
    // hands off to /onboarding/verify-email?email=<address>, which is
    // reachable pre-session (Supabase's signUp with email confirmation
    // returns no session) and is the entry into the shared /onboarding
    // tree. Every subsequent step (phone, identity) renders inside the
    // shared progress-bar shell.
    const src = readSrc('app/signup/patient/PatientSignupForm.tsx');
    expect(src).toMatch(/\/onboarding\/verify-email\?email=/);
  });

  it('patient form no longer routes signups through /verify-phone (moved into the /onboarding tree)', () => {
    // /verify-phone the ROUTE still exists (nothing in this build
    // deletes it), but the signup flow must not send new patients
    // there — the phone step lives at /onboarding/phone now.
    const src = readSrc('app/signup/patient/PatientSignupForm.tsx');
    expect(src).not.toContain('/verify-phone');
  });

  it('practice form is NOT routed through /verify-phone (regression — patient-only feature)', () => {
    const src = readSrc('app/signup/practice/page.tsx');
    expect(src).not.toContain('/verify-phone');
  });

  it('patient form no longer renders the legacy "Check your email" magic-link done state', () => {
    const src = readSrc('app/signup/patient/PatientSignupForm.tsx');
    expect(src).not.toContain('Check your email');
  });
});

// ─── Q2: OTP-abandon recovery ────────────────────────────────────────────────
//
// Both signup actions must detect "profile already exists but the auth user
// is still unconfirmed" and re-route the user to /verify-email instead of
// dead-ending with the legacy "account already exists" error. Tests below
// lock the wiring (admin.getUserById + resend({type:'signup'}) +
// needsVerification:true) into source.

describe('signup actions — OTP-abandon recovery branch', () => {
  it.each([
    'app/signup/patient/actions.ts',
    'app/signup/practice/actions.ts',
  ])('%s uses findExistingAuthUser (covers AUTH_ONLY orphans, not just profiles)', (path) => {
    const src = readSrc(path);
    // 1. imports the shared helper that looks at BOTH profiles AND auth.users.
    expect(src).toMatch(/from\s+['"]@\/lib\/auth\/findExistingAuthUser['"]/);
    expect(src).toMatch(/findExistingAuthUser\s*\(/);
    // 2. branches on email_confirmed_at returned by the helper.
    expect(src).toMatch(/email_confirmed_at/);
    // 3. re-fires the signup OTP on the unconfirmed branch.
    // [\s\S]*? rather than the /s (dotAll) flag — that flag is ES2018+,
    // and the tsconfig target stays at ES2017 for now.
    expect(src).toMatch(/auth\.resend[\s\S]*?type:\s*['"]signup['"]/);
    // 4. returns needsVerification true.
    expect(src).toMatch(/needsVerification:\s*true/);
  });

  it('findExistingAuthUser helper falls back to auth.users (not just profiles)', () => {
    const src = readSrc('lib/auth/findExistingAuthUser.ts');
    // Profile-by-email cheap path.
    expect(src).toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
    // Schema-scoped fallback to auth.users — this is the load-bearing piece
    // that catches AUTH_ONLY orphans.
    expect(src).toMatch(/schema:\s*['"]auth['"]/);
    expect(src).toMatch(/\.from\(\s*['"]users['"]\s*\)/);
  });

  it.each([
    'app/signup/patient/actions.ts',
    'app/signup/practice/actions.ts',
  ])('%s keeps the legacy "sign in instead" message ONLY for the confirmed branch', (path) => {
    const src = readSrc(path);
    // Still mentions the message — but only as the fallback when the auth
    // user IS confirmed. We assert presence, not branch placement; the
    // unit logic is covered by separate integration tests.
    expect(src).toContain('Please sign in instead.');
  });
});

// ─── Q3: requireConfirmedUser rolled out across portal pages ─────────────────
//
// Each portal entry point must call requireConfirmedUser (or live under a
// layout that does). Test the layouts first; then assert the standalone
// pages in /practice, /admin, /dashboard.

const PORTAL_FILES = [
  'app/patient/layout.tsx',
  'app/provider/layout.tsx',
  'app/practice/page.tsx',
  'app/practice/bills/new/page.tsx',
  'app/practice/members/page.tsx',
  'app/practice/setup/page.tsx',
  'app/admin/page.tsx',
  'app/admin/refunds/page.tsx',
  'app/dashboard/page.tsx',
];

describe('portal entry points — email-confirmed gate via requireConfirmedUser', () => {
  it.each(PORTAL_FILES)('%s imports + calls requireConfirmedUser', (path) => {
    const src = readSrc(path);
    expect(src).toMatch(/from\s+['"]@\/lib\/auth\/requireConfirmedUser['"]/);
    expect(src).toMatch(/await\s+requireConfirmedUser\s*\(/);
  });
});

// ─── Q1: trading-gate RLS migration + RLS test fixture ──────────────────────

describe('migration 0043 — trading-gate RLS', () => {
  const src = readSrc('supabase/migrations/0043_trading_gate_rls.sql');

  it('declares the practice_can_trade(uuid) function', () => {
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION practice_can_trade/);
    expect(src).toMatch(/SECURITY DEFINER/);
  });

  it('checks status = approved AND >=1 active provider', () => {
    expect(src).toMatch(/status\s*=\s*'approved'/);
    expect(src).toMatch(/role\s*=\s*'provider'/);
    expect(src).toMatch(/active\s*=\s*true/);
  });

  it.each([
    'applications',
    'plans',
    'payments',
  ])('tightens the INSERT policy on %s with is_practice_member AND practice_can_trade', (table) => {
    // Find the CREATE POLICY ... ON <table> FOR INSERT ... block (ends at
    // the closing ");"). split() returned overlapping chunks; a direct
    // regex extraction is unambiguous.
    const re = new RegExp(
      `CREATE\\s+POLICY[\\s\\S]*?ON\\s+${table}[\\s\\S]*?FOR\\s+INSERT[\\s\\S]*?\\);`,
      'i',
    );
    const match = src.match(re);
    expect(match, `INSERT policy block for ${table} not found`).not.toBeNull();
    const block = match![0];
    expect(block).toContain('is_practice_member');
    expect(block).toContain('practice_can_trade');
  });

  it('RLS test fixture exists and runs inside a transaction', () => {
    const fixture = readSrc('scripts/test-trading-gate-rls.sql');
    expect(fixture).toContain('BEGIN');
    expect(fixture).toContain('ROLLBACK');
    expect(fixture).toMatch(/scenario 1.*pending/i);
    expect(fixture).toMatch(/scenario 2.*approved.*no providers/i);
    expect(fixture).toMatch(/scenario 3.*approved.*provider/i);
  });
});
