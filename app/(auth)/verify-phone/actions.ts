'use server';

import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { normalizePhoneZA } from '@/lib/validation';
import { generateOtpCode, hashOtpCode } from '@/lib/sms/otp';
import { sendSms, buildOtpSmsBody } from '@/lib/sms/smsportal';
import { evaluateRisk, mayProceed } from '@/lib/risk/evaluate';

// ─── Organic-signup phone-verification server actions ────────────────────
//
// The user_id-keyed twins of app/checkout/[token]/actions.ts's
// requestPhoneOtp / verifyPhoneOtp. They share:
//   • the OTP code generation + hashing helpers (lib/sms/otp)
//   • the SMSPortal sender + body format     (lib/sms/smsportal)
//   • the rate-limit + attempt-cap policy    (server-side in the RPC)
//   • the coded-string error vocabulary      (PhoneOtpStep maps to copy)
//
// What's different from the invitation-keyed flow:
//   • The caller MUST have an authenticated, email-confirmed session.
//     No anon path reaches these actions; the RPCs themselves are
//     granted only to `authenticated`.
//   • The phone is read from the user's profile rather than form
//     state — by this point in signup the form has already saved it.
//   • Verify success stamps profiles.phone_verified_at directly here
//     (the checkout path defers that to its atomic commit). This is
//     the right place: there's no parallel commit to coordinate with.
//
// Skip-with-warning policy when SMSPORTAL_CLIENT_ID/SECRET are
// missing: requestPhoneOtpForUser returns { ok:false, code:
// 'sms_not_configured' }. The /verify-phone page surfaces a one-click
// "Continue without phone verification (SMS not configured)" button
// that calls skipPhoneVerificationIfNoSms — which itself REFUSES to
// skip when creds ARE present. This keeps dev usable without giving
// production a bypass.

export type PhoneOtpStartResultForUser =
  | { ok: true }
  | { ok: false; code:
        | 'invalid_phone'
        | 'invalid_user'
        | 'unauthenticated'
        | 'no_phone_on_profile'
        | 'phone_mismatch'          // p_phone ≠ profile.phone (0055)
        | 'too_soon'
        | 'daily_limit'
        | 'user_daily_limit'        // 10 sends in 24h across all phones (0055)
        | 'sms_failed'
        | 'sms_not_configured'
        // The aggregate fraud controls refused this send (audit S-07). A
        // separate code from the per-user caps above because it is a
        // different judgement: those say "you personally have had enough
        // today", this says "this number, or this device, or the platform's
        // SMS bill, has". The page maps it to the generic risk copy rather
        // than to a wait-and-retry message, because retrying will not help.
        | 'risk_refused'
        | 'unknown';
    };

export async function requestPhoneOtpForUser(): Promise<PhoneOtpStartResultForUser> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: 'unauthenticated' };

  // Phone comes from the profile row written at signup-form submit.
  // We deliberately do not accept it as an argument here — the action
  // is "verify the phone you signed up with", not "verify any phone".
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data: profile } = await svc
    .from('profiles')
    .select('phone')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile?.phone) return { ok: false, code: 'no_phone_on_profile' };

  const normalizedPhone = normalizePhoneZA(profile.phone);
  if (!normalizedPhone) return { ok: false, code: 'invalid_phone' };

  // Already-verified short-circuit reads from phone_verifications (the
  // source of truth), NOT profiles.phone_verified_at — defence in
  // depth against H3-style bypass even though migration 0054 locks
  // the column.
  const { data: priorVerification } = await svc
    .from('phone_verifications')
    .select('verified_at')
    .eq('user_id', user.id)
    .eq('phone_e164', normalizedPhone)
    .not('verified_at', 'is', null)
    .maybeSingle();
  if (priorVerification?.verified_at) return { ok: true };

  // ── Aggregate risk + the daily SMS budget (audit S-07) ────────────────
  //
  // Every send past this line costs a real unit at SMSPortal. 0052/0055's
  // caps bound one user and one number; they cannot see one device
  // verifying six numbers, one number being attached to three accounts —
  // the planted-verification pattern the 2026-09-02 audit describes — or
  // the platform's SMS bill for the day.
  //
  // Placed AFTER the already-verified short-circuit, so a returning user
  // whose number is already verified never touches it, and BEFORE the code
  // is generated, so a refused send costs nothing and writes nothing.
  const risk = await evaluateRisk({
    event:     'phone_otp',
    accountId: user.id,
    phone:     normalizedPhone,
  });
  if (!mayProceed(risk)) return { ok: false, code: 'risk_refused' };

  let code: string;
  let codeHash: string;
  try {
    code     = generateOtpCode();
    codeHash = hashOtpCode(code);
  } catch (err) {
    console.error('[verify-phone] hash failure', err instanceof Error ? err.message : err);
    return { ok: false, code: 'unknown' };
  }

  const { data: prepResult, error: prepErr } = await svc.rpc('prepare_phone_verification_for_user', {
    p_user_id:   user.id,
    p_phone:     normalizedPhone,
    p_code_hash: codeHash,
  });
  if (prepErr) {
    console.warn('[verify-phone] prepare_phone_verification_for_user RPC error', prepErr.message);
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

  const smsResult = await sendSms(normalizedPhone, buildOtpSmsBody(code));
  if (!smsResult.ok) {
    if (smsResult.error === 'sms_not_configured') {
      return { ok: false, code: 'sms_not_configured' };
    }
    return { ok: false, code: 'sms_failed' };
  }
  return { ok: true };
}

export type PhoneOtpVerifyResultForUser =
  | { ok: true }
  | { ok: false; code:
        | 'unauthenticated'
        | 'no_phone_on_profile'
        | 'invalid_phone'
        | 'invalid_code_format'
        | 'wrong_code'
        | 'expired'
        | 'too_many_attempts'
        | 'not_found'
        | 'unknown';
    };

export async function verifyPhoneOtpForUser(enteredCode: string): Promise<PhoneOtpVerifyResultForUser> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: 'unauthenticated' };

  const trimmed = (enteredCode ?? '').trim();
  if (!/^\d{6}$/.test(trimmed)) return { ok: false, code: 'invalid_code_format' };

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data: profile } = await svc
    .from('profiles')
    .select('phone')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile?.phone) return { ok: false, code: 'no_phone_on_profile' };

  const normalizedPhone = normalizePhoneZA(profile.phone);
  if (!normalizedPhone) return { ok: false, code: 'invalid_phone' };

  // Already-verified short-circuit reads phone_verifications (source
  // of truth), not profiles.phone_verified_at. See requestPhoneOtpForUser
  // above for the rationale.
  const { data: priorVerification } = await svc
    .from('phone_verifications')
    .select('verified_at')
    .eq('user_id', user.id)
    .eq('phone_e164', normalizedPhone)
    .not('verified_at', 'is', null)
    .maybeSingle();
  if (priorVerification?.verified_at) return { ok: true };

  let codeHash: string;
  try {
    codeHash = hashOtpCode(trimmed);
  } catch (err) {
    console.error('[verify-phone] hash failure', err instanceof Error ? err.message : err);
    return { ok: false, code: 'unknown' };
  }

  const { data: result, error: rpcErr } = await svc.rpc('verify_phone_otp_for_user', {
    p_user_id:   user.id,
    p_phone:     normalizedPhone,
    p_code_hash: codeHash,
  });
  if (rpcErr) {
    console.warn('[verify-phone] verify_phone_otp_for_user RPC error', rpcErr.message);
    return { ok: false, code: 'unknown' };
  }
  const code = result as string;
  if (code !== 'ok') {
    if (code === 'wrong_code' || code === 'expired' || code === 'too_many_attempts' || code === 'not_found') {
      return { ok: false, code };
    }
    return { ok: false, code: 'unknown' };
  }

  // Atomic at the profiles level — stamp phone_verified_at with the
  // RPC's verified_at (we re-read for the exact ts so a parallel
  // verify race can't slip past with a stale value).
  const { data: vrow } = await svc
    .from('phone_verifications')
    .select('verified_at')
    .eq('user_id',    user.id)
    .eq('phone_e164', normalizedPhone)
    .maybeSingle();

  if (!vrow?.verified_at) {
    // Defensive — shouldn't happen, the RPC just set it. Fall back
    // to now() rather than fail the action.
    await svc.from('profiles').update({ phone_verified_at: new Date().toISOString() }).eq('id', user.id);
  } else {
    await svc.from('profiles').update({ phone_verified_at: vrow.verified_at }).eq('id', user.id);
  }

  return { ok: true };
}

// ─── Skip-with-warning when SMS isn't configured ─────────────────────────
//
// Only effective when SMSPORTAL_CLIENT_ID and SMSPORTAL_CLIENT_SECRET
// are BOTH absent — i.e. a dev environment without SMS creds. In any
// other configuration this action refuses (no production bypass).
// The skip path leaves profiles.phone_verified_at = NULL — we never
// claim a phone we didn't verify. Legacy parity: pre-gate patients
// already have NULL.

export type SkipResult =
  | { ok: true }
  | { ok: false; reason: 'unauthenticated' | 'sms_is_configured' };

export async function skipPhoneVerificationIfNoSms(): Promise<SkipResult> {
  // Refuse if creds are present — this action exists for dev parity,
  // never as a production bypass.
  if (process.env.SMSPORTAL_CLIENT_ID && process.env.SMSPORTAL_CLIENT_SECRET) {
    return { ok: false, reason: 'sms_is_configured' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'unauthenticated' };

  console.warn(
    '[verify-phone] skip-without-SMS taken — SMS not configured; '
    + 'profiles.phone_verified_at remains NULL for user',
    user.id,
  );
  // Deliberately do NOT stamp phone_verified_at. We never claim we
  // verified what we didn't.
  return { ok: true };
}
