import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Signup phone-OTP wiring — source-text regression ────────────────────
//
// Migration 0053 extends the existing 0052 phone OTP to organic signup
// (keying by user_id rather than invitation_token). These tests pin
// the contract that:
//
//   • The schema change is ADDITIVE — invitation_token keying still
//     works; the existing 0052 RPCs are unchanged. Partial unique
//     indexes cover both keying modes; an XOR CHECK guarantees a
//     row carries exactly one key.
//   • The two new RPCs reuse the 0052 rate-limit + attempt-cap
//     vocabulary verbatim.
//   • The signup server actions never accept a phone from the
//     client — they read it from the user's profile, so the action
//     verifies what the patient signed up with (not an arbitrary
//     number an attacker could swap in).
//   • The skip-without-SMS dev path refuses when creds ARE present
//     (no production bypass) and leaves phone_verified_at NULL.
//   • Single OTP UI app-wide — both CheckoutForm and the signup page
//     consume the shared PhoneOtpStep, not a parallel implementation.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const MIGRATION   = read('supabase/migrations/0053_phone_verification_user_keying.sql');
const SIGNUP_ACTS = read('app/(auth)/verify-phone/actions.ts');
const SIGNUP_PAGE = read('app/(auth)/verify-phone/page.tsx');
const SIGNUP_CLI  = read('app/(auth)/verify-phone/VerifyPhoneClient.tsx');
const SHARED_STEP = read('app/_otp/PhoneOtpStep.tsx');
const CHECKOUT    = read('app/checkout/[token]/CheckoutForm.tsx');

describe('Migration 0053 — schema additive, XOR keying', () => {
  it('makes invitation_token nullable (the checkout-only keying mode is no longer the only one)', () => {
    expect(MIGRATION).toMatch(/ALTER COLUMN invitation_token DROP NOT NULL/);
  });

  it('adds user_id UUID with ON DELETE CASCADE to auth.users', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS user_id UUID/);
    expect(MIGRATION).toMatch(/REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
  });

  it('drops the old table-level UNIQUE (invitation_token, phone_e164) constraint', () => {
    // The old constraint name is auto-generated; we DROP IF EXISTS by that name.
    expect(MIGRATION).toMatch(/DROP CONSTRAINT IF EXISTS phone_verifications_invitation_token_phone_e164_key/);
  });

  it('replaces it with two partial unique indexes, one per keying mode', () => {
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX[\s\S]{0,80}phone_verifications_token_phone_uniq[\s\S]{0,200}WHERE invitation_token IS NOT NULL/);
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX[\s\S]{0,80}phone_verifications_user_phone_uniq[\s\S]{0,200}WHERE user_id IS NOT NULL/);
  });

  it('XOR CHECK forces exactly one of (invitation_token, user_id) to be present', () => {
    expect(MIGRATION).toMatch(
      /CHECK\s*\(\s*\(invitation_token IS NOT NULL\)::int\s*\+\s*\(user_id IS NOT NULL\)::int\s*=\s*1\s*\)/,
    );
  });
});

describe('Migration 0053 — _for_user RPCs reuse the 0052 vocabulary', () => {
  it('prepare_phone_verification_for_user is SECURITY DEFINER + granted to authenticated only', () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION prepare_phone_verification_for_user[\s\S]*?SECURITY DEFINER/);
    expect(MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION prepare_phone_verification_for_user\(UUID, TEXT, TEXT\) TO authenticated/);
    // NOT granted to anon — by signup-phone time the user already has a session.
    expect(MIGRATION).not.toMatch(/GRANT EXECUTE ON FUNCTION prepare_phone_verification_for_user[\s\S]*?TO anon/);
  });

  it('verify_phone_otp_for_user uses FOR UPDATE locking + the same return vocab as 0052', () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION verify_phone_otp_for_user[\s\S]*?FOR UPDATE/);
    expect(MIGRATION).toMatch(/verify_phone_otp_for_user[\s\S]*?'expired'/);
    expect(MIGRATION).toMatch(/verify_phone_otp_for_user[\s\S]*?'too_many_attempts'/);
    expect(MIGRATION).toMatch(/verify_phone_otp_for_user[\s\S]*?'wrong_code'/);
    expect(MIGRATION).toMatch(/verify_phone_otp_for_user[\s\S]*?'not_found'/);
  });

  it('rate-limit vocabulary matches 0052 exactly (30s cooldown, 5/24h, 10min expiry)', () => {
    expect(MIGRATION).toMatch(/INTERVAL '30 seconds'/);
    expect(MIGRATION).toMatch(/send_count >= 5/);
    expect(MIGRATION).toMatch(/INTERVAL '24 hours'/);
    expect(MIGRATION).toMatch(/INTERVAL '10 minutes'/);
  });

  it('prepare-for-user rejects callers whose email is not confirmed (invalid_user)', () => {
    expect(MIGRATION).toMatch(/email_confirmed_at IS NOT NULL[\s\S]*?RETURN 'invalid_user'/);
  });
});

describe('Signup server actions — reuse the OTP machinery, never trust client phone', () => {
  it('reuses lib/sms/otp + lib/sms/smsportal (no parallel hash / sender)', () => {
    expect(SIGNUP_ACTS).toMatch(/from\s+'@\/lib\/sms\/otp'/);
    expect(SIGNUP_ACTS).toMatch(/from\s+'@\/lib\/sms\/smsportal'/);
    expect(SIGNUP_ACTS).toMatch(/generateOtpCode\(\)/);
    expect(SIGNUP_ACTS).toMatch(/hashOtpCode\(/);
  });

  it('reads the phone from the user\'s profile, NEVER accepts it as an argument', () => {
    // Defence in depth — RLS would also enforce, but the action's
    // signature shape is checked here.
    expect(SIGNUP_ACTS).toMatch(/export async function requestPhoneOtpForUser\(\)/);
    expect(SIGNUP_ACTS).toMatch(/export async function verifyPhoneOtpForUser\(enteredCode: string\)/);
    expect(SIGNUP_ACTS).toMatch(/from\('profiles'\)[\s\S]{0,200}\.select\('phone/);
  });

  it('uses the session user_id when calling the _for_user RPCs (never client-supplied)', () => {
    expect(SIGNUP_ACTS).toMatch(/supabase\.auth\.getUser\(\)/);
    expect(SIGNUP_ACTS).toMatch(/rpc\('prepare_phone_verification_for_user'[\s\S]{0,400}p_user_id:\s+user\.id/);
    expect(SIGNUP_ACTS).toMatch(/rpc\('verify_phone_otp_for_user'[\s\S]{0,400}p_user_id:\s+user\.id/);
  });

  it('hands the hash to the RPC (raw code never crosses into the DB)', () => {
    expect(SIGNUP_ACTS).toMatch(/p_code_hash:\s+codeHash/);
  });

  it('only sends SMS after the prepare RPC succeeded (RPC-first, SMS-second)', () => {
    const prep = SIGNUP_ACTS.indexOf('prepare_phone_verification_for_user');
    const sms  = SIGNUP_ACTS.indexOf('sendSms(normalizedPhone');
    expect(prep).toBeGreaterThan(0);
    expect(sms).toBeGreaterThan(0);
    expect(prep).toBeLessThan(sms);
  });

  it('stamps profiles.phone_verified_at after the RPC returns ok', () => {
    expect(SIGNUP_ACTS).toMatch(/\.update\(\{\s*phone_verified_at:/);
  });

  // ─── The profile stamp can be REFUSED, and used not to be checked ──────
  //
  // 0139's trigger and 0140's unique index raise 23505 when a second patient
  // verifies a number somebody else already verified. That lands on the
  // profile write, after verify_phone_otp_for_user has already committed
  // phone_verifications.verified_at — so a discarded error returned ok on an
  // account whose phone_verified_at was never set, and onboarding then
  // blocked on it forever. These pin the three parts of the fix.

  it('checks the profile-stamp error instead of discarding it', () => {
    // The regression shape was a bare `await svc.from('profiles').update(...)`
    // whose error was never destructured.
    const stamp = SIGNUP_ACTS.match(
      /const \{ error \} = await svc\s*\n\s*\.from\('profiles'\)\s*\n\s*\.update\(\{ phone_verified_at:/,
    );
    expect(stamp, 'the profile stamp must capture its error').not.toBeNull();
    expect(SIGNUP_ACTS).not.toMatch(/^\s*await svc\.from\('profiles'\)\.update\(\{ phone_verified_at/m);
  });

  it('maps SQLSTATE 23505 to phone_taken rather than ok', () => {
    // Written as an early `!== '23505'` bail so the 23505 path can fall
    // through to the undo below; either direction is fine, the point is that
    // the code is branched on at all rather than the error being dropped.
    expect(SIGNUP_ACTS).toMatch(/error\.code (===|!==) '23505'/);
    expect(SIGNUP_ACTS).toMatch(/return 'phone_taken'/);
    expect(SIGNUP_ACTS).toMatch(/\| 'phone_taken'/);
  });

  it('undoes the verification when the stamp is refused, so the gate still shows why', () => {
    // page.tsx redirects past the gate on the phone_verifications row alone —
    // it may not read profiles.phone_verified_at (H3). So a committed
    // verification whose stamp was refused would bounce the customer into an
    // onboarding step that blocks with nothing on screen explaining it.
    expect(SIGNUP_ACTS).toMatch(
      /\.from\('phone_verifications'\)\s*\n\s*\.update\(\{ verified_at: null \}\)/,
    );
    // Only on 23505 — an unknown failure may be transient and the
    // verification genuinely stands.
    const stamp = SIGNUP_ACTS.match(/const stampPhoneVerified[\s\S]*?\n  \};/);
    expect(stamp).not.toBeNull();
    const undoAt = stamp![0].indexOf("verified_at: null");
    const unknownAt = stamp![0].indexOf("return 'unknown'");
    expect(unknownAt).toBeGreaterThan(0);
    expect(undoAt).toBeGreaterThan(unknownAt);
  });

  it('does not report success from the short-circuit while the profile is unstamped', () => {
    // The short-circuit used to `return { ok: true }` unconditionally, which
    // made the duplicate-number case unrecoverable: every retry re-took this
    // branch and reported success again.
    const branch = SIGNUP_ACTS.match(
      /if \(priorVerification\?\.verified_at\) \{[\s\S]*?\n  \}/,
    );
    expect(branch, 'verify must guard the short-circuit with a block').not.toBeNull();
    expect(branch![0]).toMatch(/stampPhoneVerified/);
    // And it re-stamps rather than reading profiles.phone_verified_at to
    // decide, which H3 (app/security-priority-1.test.ts) forbids this file.
    expect(branch![0]).not.toMatch(/profile\.phone_verified_at/);
  });

  it('gives phone_taken its own customer-facing copy', () => {
    // Without a case the customer gets the generic "tap Resend" default,
    // which is the one instruction that cannot possibly work here.
    expect(SHARED_STEP).toMatch(/case 'phone_taken':/);
    expect(SHARED_STEP).toMatch(/already verified on another account/);
  });

  it('short-circuits via phone_verifications row (idempotent on refresh, post-H3 hardening)', () => {
    // Defence in depth (audit H3, 2026-06-22): both signup server
    // actions read the already-verified state from phone_verifications
    // (source of truth), NOT profiles.phone_verified_at. Migration
    // 0054 also locks the profile column from user-side writes; this
    // read change is the second line of defence.
    expect(SIGNUP_ACTS).toMatch(/\.from\('phone_verifications'\)[\s\S]{0,400}priorVerification\?\.verified_at/);
  });
});

describe('Signup skip-without-SMS — dev parity only', () => {
  it('refuses when SMSPORTAL credentials ARE configured (no production bypass)', () => {
    expect(SIGNUP_ACTS).toMatch(/process\.env\.SMSPORTAL_CLIENT_ID && process\.env\.SMSPORTAL_CLIENT_SECRET/);
    expect(SIGNUP_ACTS).toMatch(/'sms_is_configured'/);
  });

  it('NEVER stamps phone_verified_at on the skip path (we don\'t claim what we didn\'t verify)', () => {
    // The skipPhoneVerificationIfNoSms function returns ok without
    // any .update({ phone_verified_at: ... }) call on profiles.
    // (The warn log mentions the column name as a breadcrumb — that's
    // diagnostic copy, not a write — so we check for the WRITE shape
    // specifically rather than the mere string match.)
    const skipBlock = SIGNUP_ACTS.match(/export async function skipPhoneVerificationIfNoSms[\s\S]*?\n\}/);
    expect(skipBlock).not.toBeNull();
    expect(skipBlock![0]).not.toMatch(/\.update\(\{\s*phone_verified_at/);
    expect(skipBlock![0]).not.toMatch(/\.from\(['"]profiles['"]\)/);
  });
});

describe('/verify-phone page — auth-required + idempotent', () => {
  it('redirects to /login when no session', () => {
    expect(SIGNUP_PAGE).toMatch(/redirect\(`\/login\?next=\$\{encodeURIComponent\('\/verify-phone'\)\}`\)/);
  });

  it('redirects straight to target when a verified phone_verifications row exists (post-H3 read change)', () => {
    // Per the 2026-06-22 H3 hardening, the page reads verified-state
    // from phone_verifications keyed by (user_id, phone_e164), not
    // from profiles.phone_verified_at — the column lock from 0054 is
    // the first line of defence, this read is the second.
    expect(SIGNUP_PAGE).toMatch(/\.from\('phone_verifications'\)[\s\S]{0,300}\.eq\('user_id',\s*user\.id\)/);
    expect(SIGNUP_PAGE).toMatch(/if\s*\(verification\?\.verified_at\)\s*\{[\s\S]{0,80}redirect\(target\)/);
  });

  it('passes smsConfigured hint to the client (so dev surfaces the skip eagerly)', () => {
    expect(SIGNUP_PAGE).toMatch(/SMSPORTAL_CLIENT_ID && process\.env\.SMSPORTAL_CLIENT_SECRET/);
    expect(SIGNUP_PAGE).toMatch(/smsConfigured=\{smsConfigured\}/);
  });
});

describe('Shared PhoneOtpStep — single OTP UI app-wide', () => {
  it('uses the existing components/OtpInput (NOT a parallel 6-digit widget)', () => {
    expect(SHARED_STEP).toMatch(/from\s+'@\/components\/OtpInput'/);
  });

  it('CheckoutForm consumes the shared PhoneOtpStep (not its own inline OTP block)', () => {
    expect(CHECKOUT).toMatch(/from\s+'@\/app\/_otp\/PhoneOtpStep'/);
    expect(CHECKOUT).toMatch(/<PhoneOtpStep\b/);
    // The previous inline elements should be gone — no <OtpResendButton>
    // helper, no inline single-input OTP textbox with the checkout-otp id.
    expect(CHECKOUT).not.toMatch(/id=["']checkout-otp["']/);
    expect(CHECKOUT).not.toMatch(/<OtpResendButton/);
  });

  it('signup VerifyPhoneClient consumes the shared PhoneOtpStep too', () => {
    expect(SIGNUP_CLI).toMatch(/from\s+'@\/app\/_otp\/PhoneOtpStep'/);
    expect(SIGNUP_CLI).toMatch(/<PhoneOtpStep\b/);
  });
});

describe('Checkout regression — invitation-token path is unchanged', () => {
  it('still exports + uses requestPhoneOtp / verifyPhoneOtp (the token-keyed actions)', () => {
    const checkoutActs = read('app/checkout/[token]/actions.ts');
    expect(checkoutActs).toMatch(/export async function requestPhoneOtp\b/);
    expect(checkoutActs).toMatch(/export async function verifyPhoneOtp\b/);
    expect(checkoutActs).toMatch(/rpc\('prepare_phone_verification'/);
    expect(checkoutActs).toMatch(/rpc\('verify_phone_otp'/);
  });

  it('the checkout precondition in initiateCheckout still queries by invitation_token + phone_e164', () => {
    const checkoutActs = read('app/checkout/[token]/actions.ts');
    expect(checkoutActs).toMatch(/\.eq\('invitation_token',\s+token\)/);
    expect(checkoutActs).toMatch(/\.eq\('phone_e164',\s+normalizedPhone\)/);
    expect(checkoutActs).toMatch(/error: 'verify_phone_required'/);
  });
});
