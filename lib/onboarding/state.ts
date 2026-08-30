import type { OnboardingFlags } from '@/lib/featureFlags';

// ─── Onboarding state model (pure) ─────────────────────────────────────
//
// Path-fixed step list + first-unfinished-step computation.
//
// Two concerns kept separate:
//
//   • stepListFor(user, flags) — the FULL ordered list of steps for
//     this user's PATH. Stable across the journey: an email-signup
//     user's list stays [verify-email, phone, identity, ...] even
//     after email OTP is done. Whether verify-email is IN the list is
//     determined by the user's auth IDENTITIES ('email' vs 'google'),
//     NOT by email_confirmed_at (which is truthy for Google users too).
//
//   • computeOnboarding(user, profile, flags) — returns the FIRST
//     UNFINISHED step (or {done:true}). The routing target. Never
//     changes step counts; only decides where to send the user next.
//
// This separation fixes the "Step 1 of 3 → Step 1 of 2" shrinking-total
// defect. The list length is per-path, not per-remaining-work.
//
// Cached-flag invariant: profiles.onboarding_completed is write-once-
// TRUE. Once it's set, computeOnboarding short-circuits to `{done:
// true}` without re-evaluating the underlying step conditions. That
// stops a flag flip (ENABLE_CREDIT_CHECK ON later)
// from retro-locking a patient who finished under the old flag set.
//
// Everything here is pure — no I/O, no side effects. Test with plain
// fixtures.

export type OnboardingStep =
  | 'terms'
  | 'verify-email'
  | 'phone'
  | 'salary'
  | 'identity'
  | 'credit-check';
// NOTE: there is no 'liveness' step. Liveness is not a separate stage of
// onboarding — it happens INSIDE the identity step. The Didit session
// created there proves liveness and face-matches the selfie against the
// identity-registry portrait in one ceremony, and its webhook writes
// liveness_verified_at on approval.
//
// A standalone step existed before that architecture landed, backed by
// stubLivenessCheck() which always returned 'pass' without calling any
// provider. Once the webhook started writing liveness_verified_at, the
// step could only ever be already-satisfied on arrival — or, worse,
// stamp a fake pass on someone the real face match had not cleared. It
// has been removed rather than left flagged off, because a dormant
// always-passes liveness check is a liability, not an option.

export const STEP_PATH: Record<OnboardingStep, string> = {
  'terms':        '/onboarding/terms',
  'verify-email': '/onboarding/verify-email',
  'phone':        '/onboarding/phone',
  'salary':       '/onboarding/salary',
  'identity':     '/onboarding/identity',
  'credit-check': '/onboarding/credit-check',
};

// Display copy — shown in the shell above the current step.
export const STEP_TITLE: Record<OnboardingStep, string> = {
  'terms':        'Terms & conditions',
  'verify-email': 'Verify your email',
  'phone':        'Add your cell number',
  'salary':       'Your income',
  'identity':     'Verify your identity',
  'credit-check': 'Affordability check',
};

export type UserForOnboarding = {
  email_confirmed_at: string | null;
  /**
   * The auth identity providers linked to this user. Values are the
   * Supabase identity `provider` strings — 'email' for email/password,
   * 'google' for Google OAuth, etc. Determines PATH (email vs Google
   * only). email-only signups have 'email'; Google-only signups have
   * only 'google'; an account with both linked has both.
   */
  identity_providers: readonly string[];
};

export type ProfileForOnboarding = {
  /** Set when the customer has actively agreed. See the 'terms' step. */
  terms_accepted_at:      string | null;
  phone_verified_at:      string | null;
  sa_id_number:           string | null;
  salary_day:             number | null;
  salary_amount:          number | null;
  credit_check_status:    string | null;
  liveness_verified_at:   string | null;
  onboarding_completed:   boolean;
};

export type OnboardingStatus =
  | { done: true }
  | {
      done:  false;
      step:  OnboardingStep;
      /** 1-based position of the CURRENT step within stepListFor(user, flags). */
      index: number;
      /** Length of stepListFor(user, flags) — stable across the journey. */
      total: number;
      /** Convenience: STEP_PATH[step]. */
      path:  string;
    };

/**
 * Path-fixed ordered list of steps this user will see.
 *
 * The list length is STABLE across the whole journey — a completed
 * step stays in the list, it just isn't the current step any more.
 * The verify-email inclusion is driven by identity providers, NOT by
 * email_confirmed_at, because Google users have email_confirmed_at
 * set at OAuth link time and would otherwise appear to "have a
 * completed email OTP step in their path".
 */
export function stepListFor(user: UserForOnboarding, flags: OnboardingFlags): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  // ── Terms — OAuth paths only, and first ──────────────────────────────
  //
  // An email signup ticks "I agree" inside the signup form, gated
  // server-side in signUpPatient before the account is created, so by the
  // time they reach onboarding the acceptance is already recorded and a
  // step here would be a screen they never see.
  //
  // A Google signup has no such moment. The OAuth round trip creates the
  // account with nothing agreed to, which is why acceptance used to be
  // inferred from a "by continuing…" line rather than actively given.
  // This step is that missing moment, and it is FIRST because agreeing to
  // the terms is the precondition for the rest of onboarding, not a
  // formality to collect on the way out.
  //
  // Included by IDENTITY PROVIDER rather than by whether the column is
  // already set — same rule as verify-email below, and for the same
  // reason: the list is path-fixed, so a step's presence must not depend
  // on how far along the user is.
  if (!user.identity_providers.includes('email')) steps.push('terms');
  if (user.identity_providers.includes('email')) steps.push('verify-email');
  steps.push('phone');
  // Salary comes BEFORE identity deliberately. The identity step ends by
  // redirecting the patient off-site to Didit and resolves
  // asynchronously via webhook; if salary came after it, they would have
  // to come BACK and fill in a form after verifying. This way the only
  // synchronous form work happens first and the flow can complete
  // without returning to an input.
  steps.push('salary');
  steps.push('identity');
  if (flags.creditCheck) steps.push('credit-check');
  return steps;
}

/**
 * @deprecated Alias kept for callers still importing the pre-fix name.
 * The old semantics (which dropped completed steps from the list) are
 * gone; this now returns the same value as `stepListFor`.
 */
export function stepsFor(user: UserForOnboarding, flags: OnboardingFlags): OnboardingStep[] {
  return stepListFor(user, flags);
}

function stepIsSatisfied(
  step: OnboardingStep,
  user: UserForOnboarding,
  profile: ProfileForOnboarding,
): boolean {
  switch (step) {
    case 'terms':
      return !!profile.terms_accepted_at;
    case 'verify-email':
      return !!user.email_confirmed_at;
    case 'phone':
      return !!profile.phone_verified_at;
    case 'salary':
      return profile.salary_day    !== null && profile.salary_day    !== undefined
          && profile.salary_amount !== null && profile.salary_amount !== undefined;
    case 'identity':
      // BOTH columns are written by the Didit webhook, on approval, in
      // the same update — sa_id_number for the verified identity and
      // liveness_verified_at for the face match that proved it. Checking
      // both makes the identity step's meaning explicit: the patient is
      // who they claim AND a live human. Neither can be set by the
      // patient typing into a form.
      return !!profile.sa_id_number && !!profile.liveness_verified_at;
    case 'credit-check':
      return profile.credit_check_status === 'passed';
  }
}

export function computeOnboarding(
  user:    UserForOnboarding,
  profile: ProfileForOnboarding,
  flags:   OnboardingFlags,
): OnboardingStatus {
  if (profile.onboarding_completed) return { done: true };

  const steps = stepListFor(user, flags);
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!stepIsSatisfied(step, user, profile)) {
      return {
        done:  false,
        step,
        index: i + 1,
        total: steps.length,
        path:  STEP_PATH[step],
      };
    }
  }
  return { done: true };
}

/**
 * Boolean form of the computation. Handy for the server-side
 * acceptance gate where we don't need the step index.
 */
export function isOnboarded(
  user:    UserForOnboarding,
  profile: ProfileForOnboarding,
  flags:   OnboardingFlags,
): boolean {
  return computeOnboarding(user, profile, flags).done;
}
