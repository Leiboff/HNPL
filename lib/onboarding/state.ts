import type { OnboardingFlags } from '@/lib/featureFlags';

// ─── Onboarding state model (pure) ─────────────────────────────────────
//
// Given (user, profile, flags), returns either { done: true } or the
// FIRST unfinished step for this user. Google users have
// email_confirmed_at set from the moment their identity is provisioned,
// so the 'verify-email' step naturally falls off their step list.
//
// Cached-flag invariant: profiles.onboarding_completed is write-once-
// TRUE. Once it's set, this function short-circuits to `{done: true}`
// without re-evaluating the underlying step conditions. That is what
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
  'identity':     'Your ID and salary date',
  'credit-check': 'Affordability check',
  'liveness':     'Verify it\'s really you',
};

export type UserForOnboarding = {
  email_confirmed_at: string | null;
};

export type ProfileForOnboarding = {
  phone_verified_at:      string | null;
  sa_id_number:           string | null;
  salary_day:             number | null;
  credit_check_status:    string | null;
  liveness_verified_at:   string | null;
  onboarding_completed:   boolean;
};

export type OnboardingStatus =
  | { done: true }
  | {
      done:  false;
      step:  OnboardingStep;
      /** 1-based position of the CURRENT step among the steps this user will see. */
      index: number;
      /** Total steps this user will see (Google skips verify-email; flag-off steps excluded). */
      total: number;
      /** Convenience: STEP_PATH[step]. */
      path:  string;
    };

/**
 * Ordered list of steps that apply to this specific user given the
 * current flag configuration. The order matches the flow: email OTP
 * → phone → ID+salary → credit-check → liveness. Steps that don't
 * apply (email already confirmed; flags off) are omitted.
 */
export function stepsFor(user: UserForOnboarding, flags: OnboardingFlags): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  if (!user.email_confirmed_at) steps.push('verify-email');
  steps.push('phone');
  steps.push('identity');
  if (flags.creditCheck) steps.push('credit-check');
  if (flags.liveness)    steps.push('liveness');
  return steps;
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
      return !!profile.sa_id_number && profile.salary_day !== null && profile.salary_day !== undefined;
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
  // Cached-true short-circuit. A patient who already finished under a
  // previous flag set stays done. Never re-evaluate the underlying
  // conditions once this flag is TRUE.
  if (profile.onboarding_completed) return { done: true };

  const steps = stepsFor(user, flags);
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
