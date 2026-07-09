import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepsFor, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import OnboardingShell from '@/components/onboarding/OnboardingShell';
import IdentityStepClient from './IdentityStepClient';

// ─── Step: SA ID + salary date ─────────────────────────────────────────
//
// Every patient sees this step. Server accepts:
//   • saIdNumber — validated (13 digits, Luhn + DOB + citizenship);
//     the raw value is discarded after encryption. Never logged.
//   • salaryDay  — from the shared ALLOWED_SALARY_DAYS set (1..31,
//     canonical values only).
//
// Credit-check SEAM: saveIdAndSalaryDay's server code auto-passes the
// credit check when ENABLE_CREDIT_CHECK is off (writes
// credit_check_status='passed'). When on, credit_check_status stays
// NULL and the router forwards to /onboarding/credit-check next.

export const dynamic = 'force-dynamic';

export default async function IdentityStep() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding');

  const { data: profile } = await supabase
    .from('profiles')
    .select('phone_verified_at, sa_id_number, salary_day, credit_check_status, liveness_verified_at, onboarding_completed')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile) redirect('/dashboard');

  const p = profile as ProfileForOnboarding;
  const flags = currentFlags();
  const userForState = { email_confirmed_at: user.email_confirmed_at ?? null };
  const status = computeOnboarding(userForState, p, flags);

  if (status.done || status.step !== 'identity') {
    redirect('/onboarding');
  }

  const steps = stepsFor(userForState, flags);
  const currentIndex = steps.indexOf('identity') + 1;

  return (
    <OnboardingShell
      currentIndex={currentIndex}
      total={steps.length}
      title="Your ID and salary date"
      description="We use your SA ID to run a quick affordability check and time instalments to your salary."
    >
      <IdentityStepClient />
    </OnboardingShell>
  );
}
