'use server';

import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { normalizePhoneZA } from '@/lib/validation';
import { generateOtpCode, hashOtpCode } from '@/lib/sms/otp';
import { sendSms, buildOtpSmsBody } from '@/lib/sms/smsportal';

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
        | 'too_soon'
        | 'daily_limit'
        | 'sms_failed'
        | 'sms_not_configured'
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
    .select('phone, phone_verified_at')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile?.phone) return { ok: false, code: 'no_phone_on_profile' };

  const normalizedPhone = normalizePhoneZA(profile.phone);
  if (!normalizedPhone) return { ok: false, code: 'invalid_phone' };

  // Already verified — short-circuit. The caller's UI will treat
  // 'ok' here as "you're done" and route to /patient.
  if (profile.phone_verified_at) return { ok: true };

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
    if (prepCode === 'too_soon' || prepCode === 'daily_limit' || prepCode === 'invalid_user') {
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
    .select('phone, phone_verified_at')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile?.phone) return { ok: false, code: 'no_phone_on_profile' };

  const normalizedPhone = normalizePhoneZA(profile.phone);
  if (!normalizedPhone) return { ok: false, code: 'invalid_phone' };

  // Already verified — return ok without an RPC roundtrip. Mirrors
  // the verify_phone_otp behaviour for verified rows but cheaper.
  if (profile.phone_verified_at) return { ok: true };

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
