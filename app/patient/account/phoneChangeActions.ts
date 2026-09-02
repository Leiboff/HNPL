'use server';

import { createClient as createServiceClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { normalizePhoneZA } from '@/lib/validation';
import { isPhoneAlreadyVerifiedElsewhere } from '@/lib/validation/phoneInUse';
import { generateOtpCode, hashOtpCode } from '@/lib/sms/otp';
import { sendSms, buildOtpSmsBody } from '@/lib/sms/smsportal';

// ─── Phone-CHANGE server actions ─────────────────────────────────────────
//
// THE BUG THESE FIX
//
// The account page used to change a phone number with a bare
// `.update({ phone })`. profiles.phone_verified_at is column-locked to the
// OTP path (0054 / 0065), so it stayed set from the ORIGINAL number's
// verification and the system then believed an unverified number was
// verified. lib/payments/dunningNotifications.ts sends arrears reminders to
// profiles.phone with no verification check at any of its three call sites,
// so a wrong number received the patient's payment-arrears SMS.
//
// THE MODEL
//
//   1. startPhoneChange   — validate, stage into profiles.phone_pending.
//                           Sends NOTHING.
//   2. PhoneOtpStep mounts and auto-sends, calling requestPhoneChangeOtp.
//   3. verifyPhoneChangeOtp — on success PROMOTES: phone = pending,
//                           phone_verified_at = the fresh verified_at,
//                           phone_pending = NULL. One write, three columns.
//   4. cancelPhoneChange  — clears the staging column. Nothing else to undo.
//
// Until step 3 succeeds, profiles.phone is untouched, so the old number stays
// authoritative and an abandoned change leaves a working number. And because
// phone and phone_verified_at are only ever written TOGETHER, the timestamp
// cannot describe a number other than the current one.
//
// ─── WHY THIS IS A THIRD CALLER AND NOT A SECOND MECHANISM ─────────────
//
// Everything that constitutes the OTP mechanism is reused verbatim:
//   • lib/sms/otp              — code generation + peppered hashing
//   • lib/sms/smsportal        — the sender and the SMS body format
//   • prepare_phone_verification_for_user / verify_phone_otp_for_user
//     — every cap lives server-side in those RPCs and none is touched:
//       30s resend cooldown · 5 sends per (user,phone)/24h ·
//       10 sends per user/24h · 5 wrong-code attempts · 10-minute expiry
//   • the coded-error vocabulary PhoneOtpStep already maps to copy
//
// What is written here is the thin wrapper around them — read the caller,
// pick the target column, call the RPC. app/(auth)/verify-phone/actions.ts
// says in its own header that it is the "user_id-keyed twin" of the
// token-keyed pair in app/checkout/[token]/actions.ts, sharing exactly those
// four things. This is the third member of that family, following the
// established shape. Deliberately NOT done: refactoring the other two into a
// shared core. Their behaviour is pinned by source-text tests precisely
// because they are security-sensitive, and onboarding's first-time
// verification path had to stay byte-for-byte unchanged.
//
// Migration 0099 makes this possible at all: prepare_phone_verification_for_user
// used to require p_phone = profiles.phone, so a number could never be verified
// BEFORE it became the account's number. The guard now accepts phone OR
// phone_pending. Every cap is byte-identical; see the migration for why that
// does not widen the SMS-burn surface 0055 closed.

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

/**
 * How recent a verification must be to promote a staged number.
 *
 * Same value and same reasoning as the checkout commit's
 * PHONE_VERIFY_FRESHNESS_MS — this is the established policy in this
 * codebase, not a new one.
 *
 * It is belt-and-braces rather than the primary guard: requestPhoneChangeOtp
 * always calls prepare, which resets verified_at to NULL, so a stale
 * verification normally cannot survive into this flow. The gap it closes is
 * narrow and real — if the 30-second resend cooldown rejects the auto-send
 * while a verified row for that number already exists from some earlier
 * session, verify_phone_otp_for_user would short-circuit to 'ok' on the old
 * verified_at. Promoting on a year-old verification of a since-recycled
 * number is exactly what this task exists to prevent.
 */
const PHONE_CHANGE_VERIFY_FRESHNESS_MS = 30 * 60 * 1000;

// ─── 1. Stage the change ─────────────────────────────────────────────────

export type StartPhoneChangeResult =
  | { ok: true }
  | { ok: false; code:
        | 'unauthenticated'
        | 'invalid_phone'
        | 'same_number'
        | 'unknown';
    };

/**
 * Validate a new number and stage it. Sends no SMS — PhoneOtpStep auto-sends
 * on mount, and sending here too would burn two of the five daily codes for
 * one change.
 */
export async function startPhoneChange(phoneRaw: string): Promise<StartPhoneChangeResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: 'unauthenticated' };

  // Trust-boundary validation. The client validates too, but this is the real
  // gate — the same shared validator the old save path used, unchanged.
  const normalized = normalizePhoneZA((phoneRaw ?? '').trim());
  if (!normalized) return { ok: false, code: 'invalid_phone' };

  const s = svc();
  const { data: profile } = await s
    .from('profiles')
    .select('phone')
    .eq('id', user.id)
    .maybeSingle();

  // Nothing to verify, and offering an OTP for it would be confusing.
  if (profile?.phone === normalized) return { ok: false, code: 'same_number' };

  // Service role because phone_pending is written alongside phone_verified_at
  // on promotion, and that column is locked to service-role writes.
  const { error } = await s
    .from('profiles')
    .update({ phone_pending: normalized })
    .eq('id', user.id);
  if (error) {
    console.error('[phone-change] failed to stage pending phone', error.message);
    return { ok: false, code: 'unknown' };
  }

  // Deliberately NO revalidatePath here, unlike the promote and cancel actions.
  // Staging needs no server re-render: the field transitions to the verifying
  // state locally, and a genuine reload re-reads phone_pending anyway because
  // this route is dynamic. Revalidating mid-flow would refresh the tree while
  // PhoneOtpStep is mounted — React reconciliation preserves its state at the
  // same tree position, so it would not actually re-send, but on a path where
  // an extra send costs one of five daily codes there is no reason to rely on
  // that.
  return { ok: true };
}

// ─── 2. Send / resend the code for the staged number ─────────────────────

export type PhoneChangeOtpRequestResult =
  | { ok: true }
  | { ok: false; code:
        | 'unauthenticated'
        | 'no_pending_change'
        | 'invalid_phone'
        | 'phone_mismatch'
        | 'too_soon'
        | 'daily_limit'
        | 'user_daily_limit'
        | 'sms_failed'
        | 'sms_not_configured'
        | 'invalid_user'
        | 'unknown';
    };

/**
 * Bound to PhoneOtpStep's `requestCode`. Takes no argument by design — the
 * target is read from profiles.phone_pending, never accepted from the client,
 * matching requestPhoneOtpForUser's posture ("verify the phone on your
 * profile", not "verify any phone").
 *
 * NOTE there is no already-verified short-circuit here, unlike
 * requestPhoneOtpForUser. That short-circuit exists so a patient who reloads
 * the signup gate is not re-SMSed for a number they just proved. For a CHANGE
 * the question is different — do you control this number NOW — so this always
 * asks for a fresh code. The caps below still bound how often it can.
 */
export async function requestPhoneChangeOtp(): Promise<PhoneChangeOtpRequestResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: 'unauthenticated' };

  const s = svc();
  const { data: profile } = await s
    .from('profiles')
    .select('phone_pending')
    .eq('id', user.id)
    .maybeSingle();

  const pending = profile?.phone_pending as string | null | undefined;
  if (!pending) return { ok: false, code: 'no_pending_change' };

  const normalized = normalizePhoneZA(pending);
  if (!normalized) return { ok: false, code: 'invalid_phone' };

  let code: string;
  let codeHash: string;
  try {
    code     = generateOtpCode();
    codeHash = hashOtpCode(code);
  } catch (err) {
    console.error('[phone-change] hash failure', err instanceof Error ? err.message : err);
    return { ok: false, code: 'unknown' };
  }

  const { data: prepResult, error: prepErr } = await s.rpc('prepare_phone_verification_for_user', {
    p_user_id:   user.id,
    p_phone:     normalized,
    p_code_hash: codeHash,
  });
  if (prepErr) {
    console.warn('[phone-change] prepare RPC error', prepErr.message);
    return { ok: false, code: 'unknown' };
  }
  const prepCode = prepResult as string;
  if (prepCode !== 'ok') {
    if (
      prepCode === 'too_soon' ||
      prepCode === 'daily_limit' ||
      prepCode === 'user_daily_limit' ||
      prepCode === 'phone_mismatch' ||
      prepCode === 'invalid_user'
    ) {
      return { ok: false, code: prepCode };
    }
    return { ok: false, code: 'unknown' };
  }

  const smsResult = await sendSms(normalized, buildOtpSmsBody(code));
  if (!smsResult.ok) {
    if (smsResult.error === 'sms_not_configured') {
      return { ok: false, code: 'sms_not_configured' };
    }
    return { ok: false, code: 'sms_failed' };
  }
  return { ok: true };
}

// ─── 3. Verify, then promote ─────────────────────────────────────────────

export type PhoneChangeOtpVerifyResult =
  | { ok: true }
  | { ok: false; code:
        | 'unauthenticated'
        | 'no_pending_change'
        | 'invalid_phone'
        | 'invalid_code_format'
        | 'wrong_code'
        | 'expired'
        | 'too_many_attempts'
        | 'not_found'
        | 'stale_verification'
        // Migration 0139 — another patient has already verified this number.
        | 'phone_in_use'
        | 'unknown';
    };

export async function verifyPhoneChangeOtp(enteredCode: string): Promise<PhoneChangeOtpVerifyResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: 'unauthenticated' };

  const trimmed = (enteredCode ?? '').trim();
  if (!/^\d{6}$/.test(trimmed)) return { ok: false, code: 'invalid_code_format' };

  const s = svc();
  const { data: profile } = await s
    .from('profiles')
    .select('phone_pending')
    .eq('id', user.id)
    .maybeSingle();

  const pending = profile?.phone_pending as string | null | undefined;
  if (!pending) return { ok: false, code: 'no_pending_change' };

  const normalized = normalizePhoneZA(pending);
  if (!normalized) return { ok: false, code: 'invalid_phone' };

  let codeHash: string;
  try {
    codeHash = hashOtpCode(trimmed);
  } catch (err) {
    console.error('[phone-change] hash failure', err instanceof Error ? err.message : err);
    return { ok: false, code: 'unknown' };
  }

  // The unmodified 0053 RPC — it holds the 5-attempt cap and the expiry check.
  const { data: result, error: rpcErr } = await s.rpc('verify_phone_otp_for_user', {
    p_user_id:   user.id,
    p_phone:     normalized,
    p_code_hash: codeHash,
  });
  if (rpcErr) {
    console.warn('[phone-change] verify RPC error', rpcErr.message);
    return { ok: false, code: 'unknown' };
  }
  const code = result as string;
  if (code !== 'ok') {
    if (code === 'wrong_code' || code === 'expired' || code === 'too_many_attempts' || code === 'not_found') {
      return { ok: false, code };
    }
    return { ok: false, code: 'unknown' };
  }

  // Read the exact verified_at the RPC set, rather than using now(). Same
  // reasoning as the signup path: a parallel verify race cannot then slip past
  // with a value we invented.
  const { data: vrow } = await s
    .from('phone_verifications')
    .select('verified_at')
    .eq('user_id',    user.id)
    .eq('phone_e164', normalized)
    .maybeSingle();

  const verifiedAt = vrow?.verified_at as string | null | undefined;
  if (!verifiedAt) {
    // Defensive — the RPC just set it.
    console.error('[phone-change] verify returned ok with no verified_at', { userId: user.id });
    return { ok: false, code: 'unknown' };
  }

  // See PHONE_CHANGE_VERIFY_FRESHNESS_MS. Refusing here is safe: the patient
  // taps Resend and gets a fresh code, and the staged number is untouched.
  if (Date.parse(verifiedAt) < Date.now() - PHONE_CHANGE_VERIFY_FRESHNESS_MS) {
    return { ok: false, code: 'stale_verification' };
  }

  // ── THE PROMOTION ────────────────────────────────────────────────────
  // One update, three columns. phone and phone_verified_at move together,
  // which is what makes "the timestamp always describes the current number"
  // structural rather than a rule someone has to remember. Clearing
  // phone_pending in the same write means there is no window where both a
  // current and a pending number look authoritative.
  const { error: promoteErr } = await s
    .from('profiles')
    .update({
      phone:             normalized,
      phone_verified_at: verifiedAt,
      phone_pending:     null,
    })
    .eq('id', user.id);
  if (promoteErr) {
    if (isPhoneAlreadyVerifiedElsewhere(promoteErr)) {
      // The staged number stays in phone_pending and the current number is
      // untouched — the patient is still on the number they had, which is
      // the right place to leave somebody whose change was refused.
      console.warn('[phone-change] refused — number already verified on another account', {
        userId: user.id,
      });
      return { ok: false, code: 'phone_in_use' };
    }
    console.error('[phone-change] promotion failed', promoteErr.message);
    return { ok: false, code: 'unknown' };
  }

  revalidatePath('/patient/account');
  revalidatePath('/patient/account/personal');
  revalidatePath('/patient');
  return { ok: true };
}

// ─── 4. Abandon the change ───────────────────────────────────────────────

export type CancelPhoneChangeResult =
  | { ok: true }
  | { ok: false; code: 'unauthenticated' | 'unknown' };

/**
 * Clear the staging column. Nothing else needs undoing — profiles.phone was
 * never touched, so the account is already on its previously-verified number.
 *
 * The phone_verifications row for the abandoned number is deliberately left
 * alone: its send_count is what the daily caps are computed from, and deleting
 * it would hand a caller a way to reset their own rate limit.
 */
export async function cancelPhoneChange(): Promise<CancelPhoneChangeResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: 'unauthenticated' };

  const { error } = await svc()
    .from('profiles')
    .update({ phone_pending: null })
    .eq('id', user.id);
  if (error) {
    console.error('[phone-change] failed to clear pending phone', error.message);
    return { ok: false, code: 'unknown' };
  }

  revalidatePath('/patient/account');
  revalidatePath('/patient/account/personal');
  return { ok: true };
}
