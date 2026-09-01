import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

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

  it('the patient tick links /legal/terms with lowercase "betternow" — now on the chooser', () => {
    // The tick moved off the email form and onto the /signup chooser,
    // where it sits under BOTH the email and Google options so one
    // agreement covers whichever route is taken. The wording guarantee
    // follows it.
    const src = readSrc('app/(auth)/signup/SignupEntry.tsx');
    expect(src).toContain('/legal/terms');
    expect(src).toContain('betternow');
    // …and the form no longer carries one of its own.
    expect(readSrc('app/signup/patient/PatientSignupForm.tsx')).not.toContain('patient-termsAccepted');
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

    // The AUTH_ONLY-orphan fallback. This assertion used to pin
    // `schema: 'auth'` + `.from('users')` — a PostgREST query against the
    // auth schema, which Supabase does not expose to PostgREST. It could
    // never return a row, and the test passed anyway, because it checked
    // that the code was PRESENT rather than that it could WORK. That is
    // how an inert fallback survived to production, where it cost every
    // affected address the ability to sign up ever again.
    //
    // It now goes through the SECURITY DEFINER RPC from migration 0119.
    expect(src).toMatch(/\.rpc\(\s*['"]find_auth_user_by_email['"]/);
    // Comment-stripped: the file explains the old broken mechanism by
    // name, and the explanation is worth keeping.
    expect(stripComments(src)).not.toMatch(/schema:\s*['"]auth['"]/);

    // And the RPC exists, service-role only — the grant is the whole
    // safety story for a function that answers an enumeration question.
    const migration = readSrc('supabase/migrations/0119_find_auth_user_by_email.sql');
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.find_auth_user_by_email/);
    expect(migration).toMatch(/SECURITY DEFINER/);
    expect(migration).toMatch(/REVOKE ALL\s+ON FUNCTION public\.find_auth_user_by_email\(TEXT\) FROM PUBLIC/);
    expect(migration).toMatch(/FROM anon/);
    expect(migration).toMatch(/FROM authenticated/);
    expect(migration).toMatch(/GRANT\s+EXECUTE ON FUNCTION public\.find_auth_user_by_email\(TEXT\) TO\s+service_role/);
    // Case-insensitive, or it repeats the profiles path's own miss.
    expect(migration).toMatch(/lower\(u\.email\) = lower\(btrim\(p_email\)\)/);
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

// ─── Practice accounts are INVITATION-ONLY ───────────────────────────────────
//
// /signup/practice was an open front door: ?token= was a convenience that
// pre-filled the form, and no token simply meant no prefill, so anyone who
// found the URL could raise a practice. Two things follow from closing it.
//
// First, the boundary is the SERVER ACTION, not the page. createPractice is a
// public endpoint reachable by a hand-rolled POST from someone who never
// loaded the page, so a page that renders no form proves nothing on its own.
//
// Second, the token is RE-VERIFIED rather than trusted. The caller supplies
// input.inviteToken; what decides is what the SECURITY DEFINER RPC says about
// it, and that RPC returns a row only for a non-expired, unaccepted
// invitation — so a spent or stale token fails exactly like no token at all.

describe('practice signup is invitation-only', () => {
  const ACTION = readSrc('app/signup/practice/actions.ts');
  const PAGE   = readSrc('app/signup/practice/page.tsx');

  it('the SERVER ACTION refuses without a verified invitation', () => {
    // Gated on the RPC's verdict, not on the caller's assertion.
    expect(ACTION).toMatch(/const invitation = input\.inviteToken\s*\?\s*await getPracticeInvitationByToken\(input\.inviteToken\)\s*:\s*null;/);
    expect(ACTION).toMatch(/if \(!invitation\) \{/);
    expect(ACTION).toMatch(/Practice accounts are set up by invitation/);
  });

  it('the gate runs BEFORE any account or practice is created', () => {
    // Order matters: a refusal after signUp() would leave the auth user
    // behind and strand the next attempt on "already exists".
    // Match the CALL SITES, not the prose — the file's header comment
    // describes the signUp flow long before the gate appears, so a bare
    // substring search finds the comment and reports the gate as too late.
    const gateAt   = ACTION.indexOf('if (!invitation)');
    const signUpAt = ACTION.indexOf('await supabase.auth.signUp(');
    const insertAt = ACTION.indexOf("await svc.from('practices').insert(");
    expect(gateAt).toBeGreaterThan(-1);
    expect(signUpAt).toBeGreaterThan(gateAt);
    expect(insertAt).toBeGreaterThan(gateAt);
  });

  it('the page renders no form without a verified invitation', () => {
    expect(PAGE).toMatch(/'checking' \| 'invited' \| 'none'/);
    expect(PAGE).toMatch(/if \(gate !== 'invited'\) \{/);
    expect(PAGE).toMatch(/data-testid="practice-signup-invite-only"/);
  });

  it('the refusal sends them to the ENQUIRY form, not a dead end', () => {
    // The whole point: a practice can still reach us, it just creates a
    // lead rather than an account.
    expect(PAGE).toMatch(/href="\/practices#get-in-touch"/);
    expect(PAGE).toMatch(/data-testid="practice-signup-enquire"/);
  });

  it('every failing case gets the SAME answer', () => {
    // No token, malformed, expired, already spent — one branch, one
    // message. Telling a stranger which it was tells them something about
    // an invitation that is not theirs.
    expect(PAGE).toMatch(/if \(!pre \|\| !token\) \{ setGate\('none'\); return; \}/);
  });
});

// ─── The public route in is a LEAD, never an account ─────────────────────────

describe('public practice enquiry creates a CRM lead', () => {
  const LEAD = readSrc('app/practices/publicLeadAction.ts');

  it('inserts a crm_leads row — and creates no account of any kind', () => {
    expect(LEAD).toMatch(/\.from\('crm_leads'\)\s*\.insert\(insertRow\)/);
    expect(LEAD).toMatch(/source:\s*'inbound'/);
    expect(LEAD).toMatch(/stage:\s*'new'/);
    // The line that must never appear here: this surface is anonymous and
    // must not be able to mint a user or a practice.
    expect(LEAD).not.toMatch(/auth\.signUp\(/);
    expect(LEAD).not.toMatch(/admin\.createUser\(/);
    expect(LEAD).not.toMatch(/\.from\('practices'\)/);
  });
});

