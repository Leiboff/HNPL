import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Phone-OTP wiring — source-text regression ───────────────────────────
//
// The bits a runtime test can't easily reach (the SQL inside the RPC,
// the precondition order inside initiateCheckout, the per-step UI
// pieces in CheckoutForm). These tests pin the load-bearing properties
// that, if regressed, would silently break the gate:
//
//   • Migration: locked-down RLS (no anon policies), 30s + 5/day rate
//     limits, attempt cap, expiry, idempotent verified-at, hash-only
//     storage.
//   • Server actions: precondition guards initiateCheckout BEFORE any
//     account creation, profile UPDATE includes phone_verified_at,
//     OTP code is generated + hashed server-side and NEVER returned
//     to the client. The SMS sender is called only AFTER the RPC
//     stored the hash successfully.
//   • UI: 3-step flow, Verify step uses one-time-code autocomplete,
//     Change-number resets the sent marker.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const MIGRATION = read('supabase/migrations/0052_phone_verification.sql');
const ACTIONS   = read('app/checkout/[token]/actions.ts');
const FORM      = read('app/checkout/[token]/CheckoutForm.tsx');
const SENDER    = read('lib/sms/smsportal.ts');

describe('Migration 0052 — schema + RLS lockdown', () => {
  it('adds profiles.phone_verified_at TIMESTAMPTZ (idempotent)', () => {
    expect(MIGRATION).toMatch(/ALTER TABLE profiles[\s\S]*?ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ/);
  });

  it('creates phone_verifications with code_hash (never raw code) and rate-limit fields', () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS phone_verifications/);
    expect(MIGRATION).toMatch(/code_hash\s+TEXT\s+NOT NULL/);
    expect(MIGRATION).toMatch(/last_sent_at\s+TIMESTAMPTZ/);
    expect(MIGRATION).toMatch(/send_count\s+SMALLINT/);
    expect(MIGRATION).toMatch(/attempts\s+SMALLINT/);
    expect(MIGRATION).toMatch(/UNIQUE\s*\(\s*invitation_token\s*,\s*phone_e164\s*\)/);
  });

  it('does NOT store any raw-code column — only the hash', () => {
    expect(MIGRATION).not.toMatch(/code\s+TEXT\s+NOT NULL/);
    expect(MIGRATION).not.toMatch(/raw_code/);
    expect(MIGRATION).not.toMatch(/plaintext/);
  });

  it('enables RLS on phone_verifications and grants NO anon policies (lockdown)', () => {
    expect(MIGRATION).toMatch(/ALTER TABLE phone_verifications ENABLE ROW LEVEL SECURITY/);
    // The table must NOT carry a CREATE POLICY block — service-role
    // bypasses RLS and the RPCs are SECURITY DEFINER. A CREATE POLICY
    // on this table would open a leak path.
    expect(MIGRATION).not.toMatch(/CREATE POLICY[\s\S]{0,200}ON phone_verifications/);
  });
});

describe('Migration 0052 — prepare_phone_verification RPC contract', () => {
  it('returns invalid_token when the invitation isn\'t live', () => {
    expect(MIGRATION).toMatch(/RETURN 'invalid_token'/);
  });

  it('enforces a 30-second cooldown via last_sent_at', () => {
    expect(MIGRATION).toMatch(/last_sent_at > now\(\) - INTERVAL '30 seconds'/);
    expect(MIGRATION).toMatch(/RETURN 'too_soon'/);
  });

  it('caps send_count at 5 per rolling 24 hours', () => {
    expect(MIGRATION).toMatch(/send_count >= 5/);
    expect(MIGRATION).toMatch(/INTERVAL '24 hours'/);
    expect(MIGRATION).toMatch(/RETURN 'daily_limit'/);
  });

  it('sets expires_at to now() + 10 minutes', () => {
    expect(MIGRATION).toMatch(/now\(\) \+ INTERVAL '10 minutes'/);
  });

  it('is SECURITY DEFINER with SET search_path = public + granted to anon', () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION prepare_phone_verification[\s\S]*?SECURITY DEFINER/);
    expect(MIGRATION).toMatch(/SET search_path = public/);
    expect(MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION prepare_phone_verification\(TEXT, TEXT, TEXT\) TO anon, authenticated/);
  });
});

describe('Migration 0052 — verify_phone_otp RPC contract', () => {
  it('locks the row with FOR UPDATE so concurrent verify attempts can\'t race', () => {
    expect(MIGRATION).toMatch(/FROM phone_verifications[\s\S]*?FOR UPDATE/);
  });

  it('returns ok atomically when the hash matches AND not expired AND attempts < 5', () => {
    expect(MIGRATION).toMatch(/code_hash = p_code_hash/);
    expect(MIGRATION).toMatch(/SET verified_at = now\(\)/);
  });

  it('returns expired / too_many_attempts / wrong_code with stable coded strings', () => {
    expect(MIGRATION).toMatch(/RETURN 'expired'/);
    expect(MIGRATION).toMatch(/RETURN 'too_many_attempts'/);
    expect(MIGRATION).toMatch(/RETURN 'wrong_code'/);
    expect(MIGRATION).toMatch(/RETURN 'not_found'/);
  });

  it('is idempotent on an already-verified row (returns ok, does NOT overwrite verified_at)', () => {
    expect(MIGRATION).toMatch(/IF v_row\.verified_at IS NOT NULL THEN\s*RETURN 'ok'/);
  });

  it('caps attempts at 5 (locks the row until a fresh prepare resets)', () => {
    expect(MIGRATION).toMatch(/attempts >= 5/);
  });
});

describe('initiateCheckout — precondition + profile UPDATE', () => {
  it('checks phone_verifications BEFORE any account creation work (precondition position)', () => {
    // The precondition lives between the rapid-retry throttle and the
    // discriminator + account creation. Source-text: the substring
    // `verify_phone_required` must appear BEFORE the discriminator
    // CALL site (not the import — that's at the top of the file).
    const a = ACTIONS.indexOf("verify_phone_required");
    const b = ACTIONS.indexOf("discriminateExistingUser(");  // ← call, not import
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).toBeLessThan(b);
  });

  it('rejects with verify_phone_required when no fresh verified row exists', () => {
    expect(ACTIONS).toMatch(/'phone_verifications'/);
    expect(ACTIONS).toMatch(/\.eq\('invitation_token', token\)/);
    expect(ACTIONS).toMatch(/\.eq\('phone_e164',\s+normalizedPhone\)/);
    expect(ACTIONS).toMatch(/error: 'verify_phone_required'/);
  });

  it('uses 30-minute freshness window matching the spec', () => {
    expect(ACTIONS).toMatch(/PHONE_VERIFY_FRESHNESS_MS\s*=\s*30 \* 60 \* 1000/);
  });

  it('stamps profile.phone_verified_at inside the existing profile upsert', () => {
    expect(ACTIONS).toMatch(/phone_verified_at:\s+phoneVerifiedAt/);
  });
});

describe('requestPhoneOtp / verifyPhoneOtp server actions', () => {
  it('generates + hashes the OTP server-side; the plaintext code is never returned', () => {
    // Both helpers are imported, and the action returns nothing more
    // than { ok } / { ok, code: ... } — no raw code field.
    expect(ACTIONS).toMatch(/import\s*\{\s*generateOtpCode,\s+hashOtpCode\s*\}\s*from\s*'@\/lib\/sms\/otp'/);
    expect(ACTIONS).toMatch(/code\s*=\s*generateOtpCode\(\)/);
    expect(ACTIONS).toMatch(/codeHash\s*=\s*hashOtpCode\(code\)/);
    // PhoneOtpStartResult union has no `code: string` plaintext field
    // (only `code: '...stable error string...'` on failure paths).
    expect(ACTIONS).not.toMatch(/return\s*\{\s*ok:\s*true,\s*code:\s*code\b/);
    expect(ACTIONS).not.toMatch(/return\s*\{\s*ok:\s*true,\s*plaintext/);
  });

  it('hands the precomputed hash to prepare_phone_verification (RPC sees no plaintext)', () => {
    expect(ACTIONS).toMatch(/rpc\('prepare_phone_verification',\s*\{[\s\S]*?p_code_hash:\s*codeHash/);
  });

  it('hands the precomputed hash to verify_phone_otp (RPC sees no plaintext)', () => {
    expect(ACTIONS).toMatch(/rpc\('verify_phone_otp',\s*\{[\s\S]*?p_code_hash:\s*codeHash/);
  });

  it('only calls sendSms AFTER the RPC stored the hash successfully', () => {
    // The plaintext + hash path: RPC first, then SMS. If we sent first
    // and the RPC failed, we'd have a code in the wild that nothing
    // can verify. Source-text order check:
    const prepIdx  = ACTIONS.indexOf("prepare_phone_verification");
    const smsIdx   = ACTIONS.indexOf("sendSms(normalizedPhone");
    expect(prepIdx).toBeGreaterThan(0);
    expect(smsIdx).toBeGreaterThan(0);
    expect(prepIdx).toBeLessThan(smsIdx);
  });

  it('shape-checks the OTP code (6 digits) BEFORE hashing — saves a wasted RPC call', () => {
    expect(ACTIONS).toMatch(/\/\^\\d\{6\}\$\//);
    expect(ACTIONS).toMatch(/'invalid_code_format'/);
  });
});

describe('CheckoutForm — Verify step UI contract (shared PhoneOtpStep)', () => {
  // The OTP UI was refactored into app/_otp/PhoneOtpStep so the same
  // implementation backs both the checkout Verify step AND the new
  // /verify-phone organic-signup gate (migration 0053). These
  // assertions now check the SHARED component for the UI properties
  // that matter for autofill + auto-submit, and check CheckoutForm
  // only for the wiring (mount, key-bump on change-number / verify_
  // phone_required, 3-step flow).
  const SHARED = read('app/_otp/PhoneOtpStep.tsx');

  it('is a 3-step flow now (Plan → Details → Verify; hand-off is a button spinner)', () => {
    expect(FORM).toMatch(/type Step = 1 \| 2 \| 3\b/);
  });

  it('shared PhoneOtpStep uses components/OtpInput (which declares one-time-code autocomplete)', () => {
    expect(SHARED).toMatch(/from\s+'@\/components\/OtpInput'/);
    // The underlying OtpInput already pins autoComplete / inputMode /
    // maxLength — see its own internal source. Confirm the shared
    // step actually renders it.
    expect(SHARED).toMatch(/<OtpInput\b/);
  });

  it('shared PhoneOtpStep auto-submits the verify call on the 6th digit (autofill ready)', () => {
    // OtpInput's onComplete fires when the value reaches 6 digits.
    // PhoneOtpStep wires that to handleVerify, which calls verifyCode.
    expect(SHARED).toMatch(/onComplete=\{\(full\)\s*=>\s*void handleVerify\(full\)\}/);
    expect(SHARED).toMatch(/if\s*\(!\/\^\\d\{6\}\$\/\.test\(submitted\)\)\s*return/);
  });

  it('CheckoutForm wires Change-number to remount the embedded PhoneOtpStep (re-fires auto-send)', () => {
    // The new pattern: bump otpStepKey to force remount of the shared
    // component, which re-fires its auto-send-on-mount. Replaces the
    // old setOtpSentForPhone(null) marker the pre-shared code used.
    expect(FORM).toMatch(/function handleChangeNumber/);
    expect(FORM).toMatch(/resetOtpStep\(\)/);
    expect(FORM).toMatch(/setOtpStepKey\(k\s*=>\s*k\s*\+\s*1\)/);
    expect(FORM).toMatch(/<PhoneOtpStep[\s\S]{0,200}key=\{otpStepKey\}/);
  });

  it('bounces back to Verify step (3) when initiateCheckout returns verify_phone_required', () => {
    expect(FORM).toMatch(/result\.error === 'verify_phone_required'/);
    expect(FORM).toMatch(/setStep\(3\)/);
  });

  it('shared PhoneOtpStep enforces a 30-second resend cooldown', () => {
    expect(SHARED).toMatch(/OTP_RESEND_COOLDOWN_MS\s*=\s*30 \* 1000/);
  });
});

describe('SMSPortal sender — body shape regression', () => {
  it('endpoint is https://rest.smsportal.com/bulkmessages', () => {
    expect(SENDER).toMatch(/https:\/\/rest\.smsportal\.com/);
    expect(SENDER).toMatch(/\/bulkmessages/);
  });

  it('builds Basic auth header from SMSPORTAL_CLIENT_ID + SMSPORTAL_CLIENT_SECRET', () => {
    expect(SENDER).toMatch(/SMSPORTAL_CLIENT_ID/);
    expect(SENDER).toMatch(/SMSPORTAL_CLIENT_SECRET/);
    expect(SENDER).toMatch(/Buffer\.from\(`\$\{id\}:\$\{secret\}`\)\.toString\('base64'\)/);
  });

  it('wires SMS_TEST_MODE env to a top-level testMode flag on the request body', () => {
    expect(SENDER).toMatch(/process\.env\.SMS_TEST_MODE === 'true'/);
    expect(SENDER).toMatch(/testMode: true/);
  });

  it('uses the bounded-fetch pattern with an AbortController', () => {
    expect(SENDER).toMatch(/new AbortController\(\)/);
    expect(SENDER).toMatch(/SMSPORTAL_FETCH_TIMEOUT_MS/);
  });
});
