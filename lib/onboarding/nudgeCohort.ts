import {
  computeOnboarding,
  type OnboardingStep,
  type ProfileForOnboarding,
} from './state';
import type { OnboardingFlags } from '@/lib/featureFlags';

// ─── Turning a claimed nudge row into "which step are they stuck on" ────
//
// claim_onboarding_nudges (migration 0120) deliberately returns onboarding
// FLAGS rather than a step name. The five-step state machine lives in
// lib/onboarding/state.ts and a second copy of it in SQL would drift —
// migration 0066 already carries a partial copy of the same logic, which
// is the argument for not adding another.
//
// So the SQL answers "who", and this answers "where they got to", by
// calling the same computeOnboarding() the router calls.

export type ClaimedNudgeRow = {
  id:                    string;
  email:                 string;
  first_name:            string | null;
  /** 1 or 2 — already incremented by the claim. */
  nudge_number:          number;
  phone_verified_at:     string | null;
  sa_id_number:          string | null;
  salary_day:            number | null;
  salary_amount:         number | null;
  credit_check_status:   string | null;
  liveness_verified_at:  string | null;
};

export type NudgeTarget = {
  userId:      string;
  email:       string;
  firstName:   string | null;
  nudgeNumber: number;
  step:        OnboardingStep;
  /** Human-facing name of the step, for the email subject and body. */
  stepLabel:   string;
};

/**
 * What the patient sees this step called. Deliberately not the internal
 * step id: "credit-check" in a subject line reads like a rejection.
 */
export const STEP_LABEL: Record<OnboardingStep, string> = {
  'verify-email': 'confirming your email address',
  'phone':        'confirming your cellphone number',
  'salary':       'your income details',
  'identity':     'verifying your identity',
  'credit-check': 'your affordability check',
};

/**
 * Resolve a claimed row to the step the patient stopped at.
 *
 * Returns null when the row turns out to be finished after all — which
 * the claim's own filters should already prevent, but the claim runs a
 * moment before this does, and a patient who completed onboarding in
 * between must not be emailed. Cheap to check, and the failure it
 * prevents ("you didn't finish" to someone who did) is the expensive one.
 */
export function resolveNudgeTarget(
  row:   ClaimedNudgeRow,
  flags: OnboardingFlags,
): NudgeTarget | null {
  const profile: ProfileForOnboarding = {
    phone_verified_at:    row.phone_verified_at,
    sa_id_number:         row.sa_id_number,
    salary_day:           row.salary_day,
    salary_amount:        row.salary_amount,
    credit_check_status:  row.credit_check_status,
    liveness_verified_at: row.liveness_verified_at,
    onboarding_completed: false,
  };

  // ─── Why a fixed user shape is safe here ─────────────────────────────
  //
  // computeOnboarding takes the auth user only to decide PATH: whether
  // 'verify-email' belongs in the step list at all (email signups) or
  // not (Google-only). Every patient in this cohort has a confirmed
  // email — the claim requires a progress mark, which only the email-
  // confirmation triggers set — so verify-email is SATISFIED either way
  // and the first unfinished step is identical on both paths. Passing
  // both providers keeps the longer list, which is the conservative
  // choice for the step INDEX if that is ever shown.
  const status = computeOnboarding(
    { email_confirmed_at: new Date().toISOString(), identity_providers: ['email'] },
    profile,
    flags,
  );

  if (status.done) return null;

  return {
    userId:      row.id,
    email:       row.email,
    firstName:   row.first_name,
    nudgeNumber: row.nudge_number,
    step:        status.step,
    stepLabel:   STEP_LABEL[status.step],
  };
}
