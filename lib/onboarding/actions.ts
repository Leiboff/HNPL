'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { encryptId } from '@/lib/idEncryption';
import { validateSaId, normalizePhoneZA } from '@/lib/validation';
import { isAllowedSalaryDay } from '@/lib/salaryDates';
import { currentFlags } from '@/lib/featureFlags';
import { computeOnboarding, type ProfileForOnboarding, type UserForOnboarding } from './state';
import { ONBOARDING_ADVANCE_COOKIE, ONBOARDING_ADVANCE_TTL_SECONDS, isDraftExpired } from './draft';

// ─── Server actions for the stepped onboarding gate ───────────────────
//
// One action per step (plus a finalize + credit-check / liveness stubs).
// Each action:
//   • Requires the caller to be an authenticated patient.
//   • Validates its own input (client-side is convenience, this is authority).
//   • Writes the step-scoped field(s) to profiles via service-role so
//     the profile update never accidentally requires an RLS policy
//     specific to onboarding.
//   • Calls maybeFinalize() at the end — if every applicable step is
//     now satisfied, we set onboarding_completed=TRUE ourselves.
//   • Returns a small { error, nextPath } shape the client uses to
//     navigate.

type ActionResult =
  | { error: null; nextPath: string }
  | { error: string; nextPath?: string };

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// Small helper — the shape of the profile columns computeOnboarding reads.
const PROFILE_SELECT =
  'phone_verified_at, sa_id_number, salary_day, credit_check_status, liveness_verified_at, onboarding_completed, onboarding_last_active_at';

async function loadUserAndProfile() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated.' };

  const { data: profile } = await svc()
    .from('profiles')
    .select(`role, ${PROFILE_SELECT}`)
    .eq('id', user.id)
    .maybeSingle();

  if (!profile) return { ok: false as const, error: 'Profile not found.' };
  if (profile.role !== 'patient') return { ok: false as const, error: 'Not a patient account.' };

  return {
    ok:      true as const,
    userId:  user.id,
    user:    {
      email_confirmed_at: user.email_confirmed_at ?? null,
      identity_providers: (user.identities ?? []).map((i) => i.provider),
    },
    profile: {
      phone_verified_at:    profile.phone_verified_at    as string | null,
      sa_id_number:         profile.sa_id_number         as string | null,
      salary_day:           profile.salary_day           as number | null,
      credit_check_status:  profile.credit_check_status  as string | null,
      liveness_verified_at: profile.liveness_verified_at as string | null,
      onboarding_completed: profile.onboarding_completed as boolean,
    } satisfies ProfileForOnboarding,
    // Not part of ProfileForOnboarding (the pure state model doesn't need
    // it) — kept alongside for the draft-resume actions below, which DO
    // care how stale the draft is.
    onboardingLastActiveAt: profile.onboarding_last_active_at as string | null,
  };
}

// ─── Draft-resume bookkeeping ──────────────────────────────────────────
//
// Sets the short-lived "just advanced" cookie (see lib/onboarding/draft.ts)
// so the immediately-following /onboarding load treats this as a direct
// continuation of the step that just completed, not a stale return that
// needs the "Welcome back" interstitial.
async function markOnboardingAdvance(userId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ONBOARDING_ADVANCE_COOKIE, userId, {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   ONBOARDING_ADVANCE_TTL_SECONDS,
    path:     '/',
  });
}

// Bumps the draft's last-activity stamp (profiles.onboarding_last_active_at)
// and marks the advance cookie. Called on every step write so the resume
// gate can compute 30-day expiry and distinguish "still going" from "came
// back after leaving".
async function touchDraftActivity(userId: string): Promise<void> {
  await svc()
    .from('profiles')
    .update({ onboarding_last_active_at: new Date().toISOString() })
    .eq('id', userId);
  await markOnboardingAdvance(userId);
}

// Central "am I done? if so, flag it" helper. Called at the end of
// every step action. Uses the CURRENT flag values — a step that
// auto-passes due to a flag being off still lets us reach a done state.
async function maybeFinalize(
  userId: string,
  user:   UserForOnboarding,
  profile: ProfileForOnboarding,
): Promise<{ done: boolean; nextPath: string }> {
  await touchDraftActivity(userId);
  const status = computeOnboarding(user, profile, currentFlags());
  if (status.done && !profile.onboarding_completed) {
    // Write-once-true. Persist so future flag flips can't retro-lock.
    await svc()
      .from('profiles')
      .update({
        onboarding_completed:    true,
        onboarding_completed_at: new Date().toISOString(),
      })
      .eq('id', userId);
    revalidatePath('/patient', 'layout');
    return { done: true, nextPath: '/patient' };
  }
  if (status.done) return { done: true, nextPath: '/patient' };
  return { done: false, nextPath: status.path };
}

// ─── setPhoneForOnboarding ─────────────────────────────────────────────
//
// Google patients arrive with no phone on their profile. This action
// writes it (once) so the existing prepare_phone_verification_for_user
// RPC has something to send the OTP to. Email patients captured phone
// at signup — for them this action is a no-op (phone already set) and
// we forward straight to OTP request.

export async function setPhoneForOnboarding(phoneRaw: string): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };

  const phone = normalizePhoneZA(phoneRaw);
  if (!phone) return { error: 'Enter a valid South African cellphone number.' };

  const { error } = await svc()
    .from('profiles')
    .update({ phone })
    .eq('id', loaded.userId);
  if (error) return { error: error.message };

  return { error: null, nextPath: '/onboarding/phone' };
}

// ─── saveIdAndSalaryDay ────────────────────────────────────────────────
//
// The identity step. Validates the SA ID (Luhn + DOB + citizenship),
// encrypts via idEncryption.encryptId (AES-256-GCM), writes both fields
// to the profile. Never logs the raw ID.
//
// Credit-check seam: immediately after ID validation, if
// ENABLE_CREDIT_CHECK is OFF, this action ALSO auto-passes the credit
// check (writes credit_check_status='passed'). If ON, credit_check_status
// stays NULL and the state model routes the user to the credit-check
// step next. The future integration will replace this line with a call
// to the actual bureau check.

export type SaveIdInput = {
  saIdNumber: string;
  salaryDay:  number;
};

export async function saveIdAndSalaryDay(input: SaveIdInput): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };

  const cleanedId = input.saIdNumber.replace(/\s+/g, '');
  const check = validateSaId(cleanedId);
  if (!check.valid) {
    // Deliberately generic surface — see the signup form's SA_ID
    // rationale: never leak which sub-check failed.
    return { error: 'Please enter a valid SA ID number.' };
  }

  if (!Number.isInteger(input.salaryDay) || !isAllowedSalaryDay(input.salaryDay)) {
    return { error: 'Please choose when your salary is paid.' };
  }

  let encrypted: string;
  try {
    encrypted = encryptId(cleanedId);
  } catch {
    return { error: 'Encryption error — please contact support.' };
  }

  const flags = currentFlags();

  const patch: Record<string, unknown> = {
    sa_id_number: encrypted,
    salary_day:   input.salaryDay,
  };

  // Credit-check seam. Flag-off auto-passes so the state model can
  // reach a done state without rendering a dead screen. Flag-on
  // leaves credit_check_status NULL → state routes to /onboarding/credit-check
  // next, where the (future) integration will run.
  if (!flags.creditCheck) {
    patch.credit_check_status       = 'passed';
    patch.credit_check_completed_at = new Date().toISOString();
  }

  const { error } = await svc()
    .from('profiles')
    .update(patch)
    .eq('id', loaded.userId);
  if (error) return { error: error.message };

  // Re-read to compute the next step. Cheap; keeps the state derivation
  // in one place (computeOnboarding).
  const nextProfile: ProfileForOnboarding = {
    ...loaded.profile,
    sa_id_number:              encrypted,
    salary_day:                input.salaryDay,
    credit_check_status:       flags.creditCheck ? loaded.profile.credit_check_status : 'passed',
    credit_check_completed_at: undefined as unknown as string | null,   // not read by state
  } as ProfileForOnboarding;

  const finalize = await maybeFinalize(loaded.userId, loaded.user, nextProfile);
  return { error: null, nextPath: finalize.nextPath };
}

// ─── runCreditCheck ────────────────────────────────────────────────────
//
// Integration seam. Today: with ENABLE_CREDIT_CHECK on, this is a stub
// that marks the check as 'passed'; a real credit + affordability
// integration will replace the body. With the flag OFF, saveIdAndSalaryDay
// auto-passes so this action isn't reached. Included for the flag-on
// path.

export async function runCreditCheck(): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };
  if (!currentFlags().creditCheck) {
    // Flag off — should be unreachable but never fail on it.
    return { error: null, nextPath: '/onboarding' };
  }

  // Stub — real integration replaces this block. Placeholder pass
  // preserves the flow while the bureau contract is wired up.
  const { error } = await svc()
    .from('profiles')
    .update({
      credit_check_status:       'passed',
      credit_check_completed_at: new Date().toISOString(),
    })
    .eq('id', loaded.userId);
  if (error) return { error: error.message };

  const nextProfile: ProfileForOnboarding = {
    ...loaded.profile,
    credit_check_status: 'passed',
  };
  const finalize = await maybeFinalize(loaded.userId, loaded.user, nextProfile);
  return { error: null, nextPath: finalize.nextPath };
}

// ─── runLiveness ───────────────────────────────────────────────────────
//
// Integration seam. Today: with ENABLE_LIVENESS on, marks liveness as
// verified via a stub. With the flag OFF, this route redirects the user
// out; the state model excludes 'liveness' from their step list.

export async function runLiveness(): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };
  if (!currentFlags().liveness) {
    return { error: null, nextPath: '/onboarding' };
  }

  const now = new Date().toISOString();
  const { error } = await svc()
    .from('profiles')
    .update({ liveness_verified_at: now })
    .eq('id', loaded.userId);
  if (error) return { error: error.message };

  const nextProfile: ProfileForOnboarding = {
    ...loaded.profile,
    liveness_verified_at: now,
  };
  const finalize = await maybeFinalize(loaded.userId, loaded.user, nextProfile);
  return { error: null, nextPath: finalize.nextPath };
}

// ─── refreshOnboardingState ───────────────────────────────────────────
//
// The phone step uses the existing `verifyPhoneOtpForUser` RPC to set
// phone_verified_at. That code path doesn't know about the onboarding
// finalize helper, so after a successful OTP the client calls THIS
// action to re-run maybeFinalize and get its next redirect target.

export async function refreshOnboardingState(): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };
  const finalize = await maybeFinalize(loaded.userId, loaded.user, loaded.profile);
  return { error: null, nextPath: finalize.nextPath };
}

// ─── Draft-resume interstitial actions ─────────────────────────────────
//
// Backing the "Welcome back — continue your application?" gate at
// /onboarding. Neither action ever runs silently — both are only
// reachable from an explicit button press on that interstitial, which
// itself only renders when a genuine in-progress draft exists (see the
// router's resume gate in app/onboarding/page.tsx).

// ─── continueOnboardingDraft ────────────────────────────────────────────
//
// "Continue" — re-confirms this is the same authenticated patient (the
// interstitial displayed their masked verified email/phone before this
// was ever callable) and forwards to wherever computeOnboarding says
// they left off. Data is untouched; only the activity stamp moves.

export async function continueOnboardingDraft(): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };

  // Server-side enforcement, not just the interstitial hiding the
  // button: an expired (30+ day) draft can only be started over, even
  // if this action were called directly.
  if (isDraftExpired(loaded.onboardingLastActiveAt)) {
    return { error: 'This application has expired. Please start over.' };
  }

  await touchDraftActivity(loaded.userId);
  const status = computeOnboarding(loaded.user, loaded.profile, currentFlags());
  return { error: null, nextPath: status.done ? '/patient' : status.path };
}

// ─── startOverOnboardingDraft ───────────────────────────────────────────
//
// "Start over" — clears the DRAFT fields only (everything captured from
// the phone step onward: phone, SA ID, salary day, credit check,
// liveness). Deliberately leaves untouched:
//   • the verified contact itself — auth.users.email_confirmed_at (or
//     the Google OAuth link) is never re-required; "start over" means
//     redo the application, not redo proving who you are. The draft
//     only ever existed because that verification already happened.
//   • terms_accepted_at / terms_version / privacy_version (T&Cs
//     acceptance is out of scope for this action).
// Resets onboarding_last_active_at to now — a fresh draft, fresh clock.

export async function startOverOnboardingDraft(): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };

  const now = new Date().toISOString();
  const { error } = await svc()
    .from('profiles')
    .update({
      phone:                     null,
      phone_verified_at:         null,
      sa_id_number:              null,
      salary_day:                null,
      credit_check_status:       null,
      credit_check_completed_at: null,
      liveness_verified_at:      null,
      onboarding_last_active_at: now,
    })
    .eq('id', loaded.userId);
  if (error) return { error: error.message };

  await markOnboardingAdvance(loaded.userId);

  const freshProfile: ProfileForOnboarding = {
    ...loaded.profile,
    phone_verified_at:    null,
    sa_id_number:         null,
    salary_day:           null,
    credit_check_status:  null,
    liveness_verified_at: null,
  };
  const status = computeOnboarding(loaded.user, freshProfile, currentFlags());
  return { error: null, nextPath: status.done ? '/patient' : status.path };
}
