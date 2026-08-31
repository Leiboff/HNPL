import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepListFor, type ProfileForOnboarding, type UserForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import OnboardingShell from '@/components/onboarding/OnboardingShell';
import CreditCheckStepClient from './CreditCheckStepClient';

// ─── Step (SEAM): affordability / credit check ────────────────────────
//
// Flag-off (ENABLE_CREDIT_CHECK false) — the step isn't in the user's
// step list, so the router never sends them here. Direct-URL access
// bounces to /onboarding.

export const dynamic = 'force-dynamic';

export default async function CreditCheckStep() {
  const flags = currentFlags();
  if (!flags.creditCheck) redirect('/onboarding');

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding');

  const { data: profile } = await supabase
    .from('profiles')
    .select('phone_verified_at, sa_id_number, salary_day, salary_amount, credit_check_status, liveness_verified_at, onboarding_completed')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile) redirect('/dashboard');

  const p = profile as ProfileForOnboarding;
  const userForState: UserForOnboarding = {
    email_confirmed_at: user.email_confirmed_at ?? null,
    identity_providers: (user.identities ?? []).map((i) => i.provider),
  };
  const status = computeOnboarding(userForState, p, flags);

  if (status.done || status.step !== 'credit-check') {
    redirect('/onboarding');
  }

  const steps = stepListFor(userForState, flags);

  return (
    <OnboardingShell
      steps={steps}
      currentStep="credit-check"
      title="Affordability check"
      description="We check that instalments won't stretch your budget too far. This takes a few seconds."
      minHeight={240}
    >
      <CreditCheckStepClient />
    </OnboardingShell>
  );
}
