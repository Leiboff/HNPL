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
// stops a flag flip (ENABLE_CREDIT_CHECK / ENABLE_LIVENESS ON later)
// from retro-locking a patient who finished under the old flag set.
//
// Everything here is pure — no I/O, no side effects. Test with plain
// fixtures.

export type OnboardingStep =
  | 'verify-email'
  | 'phone'
  | 'identity'
  | 'credit-check'
  | 'liveness';

export const STEP_PATH: Record<OnboardingStep, string> = {
  'verify-email': '/onboarding/verify-email',
  'phone':        '/onboarding/phone',
  'identity':     '/onboarding/identity',
  'credit-check': '/onboarding/credit-check',
  'liveness':     '/onboarding/liveness',
};

// Display copy — shown in the shell above the current step.
export const STEP_TITLE: Record<OnboardingStep, string> = {
  'verify-email': 'Verify your email',
  'phone':        'Add your cell number',
  'identity':     'Your ID and salary details',
  'credit-check': 'Affordability check',
  'liveness':     'Verify it\'s really you',
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
  if (user.identity_providers.includes('email')) steps.push('verify-email');
  steps.push('phone');
  steps.push('identity');
  if (flags.creditCheck) steps.push('credit-check');
  if (flags.liveness)    steps.push('liveness');
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
    case 'verify-email':
      return !!user.email_confirmed_at;
    case 'phone':
      return !!profile.phone_verified_at;
    case 'identity':
      return !!profile.sa_id_number
        && profile.salary_day    !== null && profile.salary_day    !== undefined
        && profile.salary_amount !== null && profile.salary_amount !== undefined;
    case 'credit-check':
      return profile.credit_check_status === 'passed';
    case 'liveness':
      return !!profile.liveness_verified_at;
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
