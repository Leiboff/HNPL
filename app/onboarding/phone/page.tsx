import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepListFor, type ProfileForOnboarding, type UserForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import OnboardingShell from '@/components/onboarding/OnboardingShell';
import PhoneStepClient from './PhoneStepClient';

// ─── Step: cell number + phone OTP ────────────────────────────────────
//
// Applies to every patient. Email patients (post-slim signup) have no
// captured phone yet — the client renders phone-entry first. Google
// patients also have no phone — same starting point. The client owns
// the two-stage phone-entry → OTP flow.

export const dynamic = 'force-dynamic';

export default async function PhoneStep() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding');

  const { data: profile } = await supabase
    .from('profiles')
    .select('phone, phone_verified_at, sa_id_number, salary_day, salary_amount, credit_check_status, liveness_verified_at, onboarding_completed')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile) redirect('/dashboard');

  const p = profile as ProfileForOnboarding & { phone: string | null };
  const flags = currentFlags();
  const userForState: UserForOnboarding = {
    email_confirmed_at: user.email_confirmed_at ?? null,
    identity_providers: (user.identities ?? []).map((i) => i.provider),
  };
  const status = computeOnboarding(userForState, p, flags);

  if (status.done || status.step !== 'phone') {
    redirect('/onboarding');
  }

  const steps = stepListFor(userForState, flags);

  return (
    <OnboardingShell
      steps={steps}
      currentStep="phone"
      title="Add your cell number"
      description="We'll send a code to confirm it's really you. Standard SMS rates apply."
    >
      <PhoneStepClient existingPhone={(profile.phone as string | null) ?? null} />
    </OnboardingShell>
  );
}
