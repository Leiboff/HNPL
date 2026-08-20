import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepListFor, type ProfileForOnboarding, type UserForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import OnboardingShell from '@/components/onboarding/OnboardingShell';
import LivenessStepClient from './LivenessStepClient';

// ─── Step (SEAM): liveness verification ────────────────────────────────
//
// Flag-off (ENABLE_LIVENESS false) — the step isn't in the user's list;
// the router never sends them here. Direct-URL bounces to /onboarding.

export const dynamic = 'force-dynamic';

export default async function LivenessStep() {
  const flags = currentFlags();
  if (!flags.liveness) redirect('/onboarding');

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

  if (status.done || status.step !== 'liveness') {
    redirect('/onboarding');
  }

  const steps = stepListFor(userForState, flags);

  return (
    <OnboardingShell
      steps={steps}
      currentStep="liveness"
      title="Verify it's really you"
      description="A short face-camera check to confirm you're the ID holder. About 20 seconds."
      minHeight={560}
    >
      <LivenessStepClient />
    </OnboardingShell>
  );
}
