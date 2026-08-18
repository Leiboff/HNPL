import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Phone-change re-verification — the guarantees, at source level ───────
//
// The state machine is tested behaviourally in
// ../profile/PhoneField.test.tsx. What only source can answer is what gets
// WRITTEN and WHEN: that profiles.phone is never written before a code
// checks out, that phone and phone_verified_at move together, and that the
// OTP mechanism the fix leans on was reused rather than reimplemented or
// relaxed.
//
// Comments are stripped. These files discuss at length the very writes some
// assertions require to be absent — the account page explains why it no
// longer holds an updateProfile action — so an un-stripped read would let
// the prose satisfy the assertion.

const ROOT     = resolve(process.cwd());
const read     = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const codeOf   = (p: string) => stripComments(read(p));

const ACTIONS  = codeOf('app/patient/account/phoneChangeActions.ts');
const PAGE     = codeOf('app/patient/account/page.tsx');
const FIELD    = codeOf('app/patient/profile/PhoneField.tsx');
const MIG      = read('supabase/migrations/0099_phone_change_reverification.sql');
const MIG_0055 = read('supabase/migrations/0055_phone_otp_burn_caps.sql');
const SIGNUP   = codeOf('app/(auth)/verify-phone/actions.ts');
const ONBOARD  = codeOf('lib/onboarding/actions.ts');
const DUNNING  = codeOf('lib/payments/dunningNotifications.ts');

// ─── The core invariant ───────────────────────────────────────────────────

describe('profiles.phone is only ever written together with a fresh verification', () => {
  it('the ONLY write to profiles.phone is the promotion, and it carries all three columns', () => {
    // THE test. If a bare `.update({ phone })` ever reappears, the original
    // bug is back: phone_verified_at would keep describing the previous
    // number and dunning would SMS an unverified one.
    const phoneWrites = ACTIONS.match(/\.update\(\{[\s\S]*?\}\)/g) ?? [];
    const writesTouchingPhone = phoneWrites.filter((w) => /\bphone:/.test(w));
    expect(writesTouchingPhone).toHaveLength(1);

    const promotion = writesTouchingPhone[0];
    expect(promotion).toMatch(/phone:\s+normalized/);
    expect(promotion).toMatch(/phone_verified_at:\s+verifiedAt/);
    expect(promotion).toMatch(/phone_pending:\s+null/);
  });

  it('phone_verified_at is never set to now() — always the RPC\'s own verified_at', () => {
    // Using now() would invent a verification we did not perform, and would
    // also let a parallel verify race slip past with a value we made up.
    expect(ACTIONS).toMatch(/phone_verified_at:\s+verifiedAt/);
    expect(ACTIONS).not.toMatch(/phone_verified_at:\s+new Date\(\)/);
  });

  it('staging writes phone_pending and NOTHING else', () => {
    // A staging write that also touched phone would defeat the whole design.
    const stageBlock = ACTIONS.slice(
      ACTIONS.indexOf('export async function startPhoneChange'),
      ACTIONS.indexOf('export async function requestPhoneChangeOtp'),
    );
    expect(stageBlock).toMatch(/\.update\(\{ phone_pending: normalized \}\)/);
    expect(stageBlock).not.toMatch(/phone:\s/);
    expect(stageBlock).not.toMatch(/phone_verified_at/);
  });

  it('cancelling clears only the staging column', () => {
    const cancelBlock = ACTIONS.slice(ACTIONS.indexOf('export async function cancelPhoneChange'));
    expect(cancelBlock).toMatch(/\.update\(\{ phone_pending: null \}\)/);
    expect(cancelBlock).not.toMatch(/phone_verified_at/);
    // And it does NOT delete the phone_verifications row — send_count there is
    // what the daily caps are computed from, so deleting it would hand the
    // caller a way to reset their own rate limit.
    expect(cancelBlock).not.toMatch(/phone_verifications/);
    expect(cancelBlock).not.toMatch(/\.delete\(/);
  });

  it('promotion is gated on a FRESH verification, not any historical one', () => {
    // Narrow but real: if the 30s resend cooldown rejects the auto-send while
    // an old verified row for that number exists, the verify RPC
    // short-circuits to 'ok' on the old verified_at. Promoting on a year-old
    // verification of a since-recycled number is what this task prevents.
    expect(ACTIONS).toMatch(/PHONE_CHANGE_VERIFY_FRESHNESS_MS/);
    expect(ACTIONS).toMatch(/Date\.parse\(verifiedAt\) < Date\.now\(\) - PHONE_CHANGE_VERIFY_FRESHNESS_MS/);
    expect(ACTIONS).toMatch(/'stale_verification'/);
  });

  it('the target phone is read from the profile, never accepted from the client', () => {
    // Same posture as requestPhoneOtpForUser: "verify the phone on your
    // profile", not "verify any phone". A client-supplied target would reopen
    // the SMS-burn vector from a different direction.
    expect(ACTIONS).toMatch(/export async function requestPhoneChangeOtp\(\)/);
    expect(ACTIONS).toMatch(/export async function verifyPhoneChangeOtp\(enteredCode: string\)/);
    expect(ACTIONS).toMatch(/\.select\('phone_pending'\)/);
  });

  it('every action authenticates before doing anything', () => {
    for (const fn of [
      'startPhoneChange', 'requestPhoneChangeOtp', 'verifyPhoneChangeOtp', 'cancelPhoneChange',
    ]) {
      const at = ACTIONS.indexOf(`export async function ${fn}`);
      expect(at, fn).toBeGreaterThan(0);
      const body = ACTIONS.slice(at, at + 400);
      expect(body, fn).toMatch(/auth\.getUser\(\)/);
      expect(body, fn).toMatch(/'unauthenticated'/);
    }
  });
});

// ─── The bug's original site is gone ─────────────────────────────────────

describe('the account page no longer writes a phone at all', () => {
  it('the old updateProfile action is gone', () => {
    expect(PAGE).not.toMatch(/updateProfile/);
    expect(PAGE).not.toMatch(/\.update\(\{ phone \}\)/);
  });

  it('the page passes the four change actions through instead', () => {
    for (const fn of [
      'startPhoneChange', 'requestPhoneChangeOtp', 'verifyPhoneChangeOtp', 'cancelPhoneChange',
    ]) {
      expect(PAGE, fn).toMatch(new RegExp(`${fn}=\\{${fn}\\}`));
    }
    expect(PAGE).toMatch(/from '\.\/phoneChangeActions'/);
  });

  it('the page reads the two columns the field needs to be honest', () => {
    expect(PAGE).toMatch(/phone, phone_pending, phone_verified_at/);
  });

  it('the field surfaces verification state and a pending change', () => {
    // "A pending change should be visible, not silent."
    expect(FIELD).toMatch(/pending \? 'verifying' : 'idle'/);
    expect(FIELD).toMatch(/data-testid="phone-state-verified"|phone-state-verified/);
    expect(FIELD).toMatch(/Verifying \{maskPhone\(staged\)\}/);
  });
});

// ─── Reuse, not reimplementation ─────────────────────────────────────────

describe('the OTP mechanism is reused verbatim', () => {
  it('uses the shared code/hash helpers and the shared sender', () => {
    expect(ACTIONS).toMatch(/from '@\/lib\/sms\/otp'/);
    expect(ACTIONS).toMatch(/from '@\/lib\/sms\/smsportal'/);
    expect(ACTIONS).toMatch(/generateOtpCode\(\)/);
    expect(ACTIONS).toMatch(/hashOtpCode\(/);
    expect(ACTIONS).toMatch(/sendSms\(normalized, buildOtpSmsBody\(code\)\)/);
  });

  it('calls the SAME two RPCs — no new verification function', () => {
    expect(ACTIONS).toMatch(/rpc\('prepare_phone_verification_for_user'/);
    expect(ACTIONS).toMatch(/rpc\('verify_phone_otp_for_user'/);
    // No second mechanism: nothing here hashes, compares or expires a code
    // itself, and no new RPC was introduced for this flow.
    expect(ACTIONS).not.toMatch(/rpc\('prepare_phone_change|rpc\('verify_phone_change/);
    // And no cap LOGIC lives here — the thresholds are the RPCs' job. Scoped
    // to logic rather than vocabulary: an earlier version of this assertion
    // banned the substring "attempts" and tripped on the 'too_many_attempts'
    // error code, which is a pass-through of the RPC's own return value and is
    // exactly the reuse being asserted.
    expect(ACTIONS).not.toMatch(/INTERVAL/);
    expect(ACTIONS).not.toMatch(/attempts\s*[+>=]/);
    expect(ACTIONS).not.toMatch(/send_count/);
    expect(ACTIONS).not.toMatch(/expires_at/);
  });

  it('reuses the shared OTP UI rather than building a second one', () => {
    expect(FIELD).toMatch(/from '@\/app\/_otp\/PhoneOtpStep'/);
    expect(FIELD).toMatch(/<PhoneOtpStep/);
    // The field must not re-implement the input or the resend cooldown.
    expect(FIELD).not.toMatch(/OtpInput/);
    expect(FIELD).not.toMatch(/COOLDOWN|setInterval/);
  });

  it('the field does not send the first code itself — the step auto-sends', () => {
    // Sending from both would burn two of the five daily codes per change.
    const stage = FIELD.slice(FIELD.indexOf('function onSendCode'), FIELD.indexOf('function onCancel'));
    expect(stage).toMatch(/startPhoneChange\(raw\)/);
    expect(stage).not.toMatch(/requestPhoneChangeOtp/);
  });
});

// ─── The caps are untouched ──────────────────────────────────────────────

describe('every attempt cap and rate limit survives unchanged', () => {
  it('0099 reproduces each cap byte-identically from 0055', () => {
    // The migration replaces prepare_phone_verification_for_user to widen ONE
    // guard clause. Every threshold must come through unchanged — this is the
    // assertion that would catch a cap being softened while nobody looked.
    for (const cap of [
      "INTERVAL '30 seconds'",
      'send_count >= 5',
      "INTERVAL '24 hours'",
      "INTERVAL '10 minutes'",
      'v_user_total >= 10',
    ]) {
      expect(MIG, cap).toContain(cap);
      expect(MIG_0055, cap).toContain(cap);
    }
  });

  it('the widened guard still refuses a phone that is on neither column', () => {
    expect(MIG).toMatch(/p_phone IS DISTINCT FROM v_profile_phone\s*\n\s*AND p_phone IS DISTINCT FROM v_profile_pending/);
    expect(MIG).toMatch(/RETURN 'phone_mismatch'/);
    // A NULL p_phone must not slip through the two DISTINCT comparisons.
    expect(MIG).toMatch(/IF p_phone IS NULL/);
  });

  it('0099 does NOT touch the verify RPC, which holds the attempt cap', () => {
    // The 5-wrong-attempt cap and the expiry check live in
    // verify_phone_otp_for_user (0053). It has no phone-match check, so it
    // needed no change — and must not have received one.
    expect(MIG).not.toMatch(/CREATE OR REPLACE FUNCTION verify_phone_otp_for_user/);
    expect(MIG).not.toMatch(/attempts >= 5/);
  });

  it('0099 changes no GRANT', () => {
    // CREATE OR REPLACE preserves grants; an explicit GRANT here would be a
    // privilege change smuggled into a bug fix.
    expect(MIG).not.toMatch(/^\s*GRANT /m);
    expect(MIG).not.toMatch(/TO anon/);
  });

  it('the new column is additive and nothing is dropped', () => {
    expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS phone_pending TEXT/);
    expect(MIG).not.toMatch(/DROP COLUMN/i);
    expect(MIG).not.toMatch(/DROP FUNCTION/i);
    // Documented in the schema, like the columns around it.
    expect(MIG).toMatch(/COMMENT ON COLUMN public\.profiles\.phone_pending/);
  });
});

// ─── Regressions ─────────────────────────────────────────────────────────

describe('the first-time verification paths are untouched', () => {
  it('the organic-signup actions still hold their own machinery, unchanged', () => {
    // Explicit regression requirement. This file was deliberately NOT
    // refactored into a shared core with the new change flow: its behaviour is
    // pinned by source-text tests precisely because it is security-sensitive.
    expect(SIGNUP).toMatch(/export async function requestPhoneOtpForUser\(\)/);
    expect(SIGNUP).toMatch(/export async function verifyPhoneOtpForUser\(enteredCode: string\)/);
    expect(SIGNUP).toMatch(/rpc\('prepare_phone_verification_for_user'/);
    expect(SIGNUP).toMatch(/rpc\('verify_phone_otp_for_user'/);
    expect(SIGNUP).toMatch(/\.update\(\{ phone_verified_at:/);
    // It reads profiles.phone — NOT phone_pending. The two flows target
    // different columns, which is what keeps them independent.
    expect(SIGNUP).toMatch(/\.select\('phone'\)/);
    expect(SIGNUP).not.toMatch(/phone_pending/);
  });

  it('onboarding still writes profiles.phone directly for a first-time number', () => {
    // setPhoneForOnboarding writes the phone so the RPC has a target. That is
    // correct and must not be routed through staging: there is no prior
    // verified number to protect, phone_verified_at is NULL, and the OTP step
    // follows immediately.
    expect(ONBOARD).toMatch(/export async function setPhoneForOnboarding/);
    expect(ONBOARD).toMatch(/\.update\(\{ phone \}\)/);
    expect(ONBOARD).not.toMatch(/phone_pending/);
  });

  it('dunning still reads profiles.phone and needed no gate added', () => {
    // The fix is upstream: profiles.phone is now trustworthy by construction.
    // Adding a verification gate here would risk suppressing legitimate
    // arrears reminders, which is a worse failure than the one being fixed.
    expect(DUNNING).toMatch(/if \(ctx\.phone\)/);
    expect(DUNNING).not.toMatch(/phone_verified_at/);
    expect(DUNNING).not.toMatch(/phone_pending/);
  });

  it('nothing sends SMS to the pending number', () => {
    // phone_pending is never authoritative. The ONLY thing that may text it is
    // the OTP itself, from requestPhoneChangeOtp.
    const senders = [DUNNING, codeOf('app/(auth)/verify-phone/actions.ts')];
    for (const src of senders) expect(src).not.toMatch(/phone_pending/);
    const sendBlock = ACTIONS.slice(
      ACTIONS.indexOf('export async function requestPhoneChangeOtp'),
      ACTIONS.indexOf('export async function verifyPhoneChangeOtp'),
    );
    expect(sendBlock).toMatch(/sendSms\(normalized, buildOtpSmsBody\(code\)\)/);
  });
});
