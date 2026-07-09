import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepsFor, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import OnboardingShell from '@/components/onboarding/OnboardingShell';
import CreditCheckStepClient from './CreditCheckStepClient';

// ─── Step (SEAM): affordability / credit check ────────────────────────
//
// Flag-off (ENABLE_CREDIT_CHECK false) — the step doesn't exist in the
// user's step list, so the router never sends them here. Direct-URL
// access bounces to /onboarding.
//
// Flag-on — renders a stub that calls runCreditCheck() (a placeholder
// pass today). The real credit + affordability integration will
// replace runCreditCheck()'s body without changing the flow, the
// route, or the state model.

export const dynamic = 'force-dynamic';

export default async function CreditCheckStep() {
  const flags = currentFlags();
  if (!flags.creditCheck) redirect('/onboarding');

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
  const userForState = { email_confirmed_at: user.email_confirmed_at ?? null };
  const status = computeOnboarding(userForState, p, flags);

  if (status.done || status.step !== 'credit-check') {
    redirect('/onboarding');
  }

  const steps = stepsFor(userForState, flags);
  const currentIndex = steps.indexOf('credit-check') + 1;

  return (
    <OnboardingShell
      currentIndex={currentIndex}
      total={steps.length}
      title="Affordability check"
      description="We check that instalments won't stretch your budget too far. This takes a few seconds."
    >
      <CreditCheckStepClient />
    </OnboardingShell>
  );
}
