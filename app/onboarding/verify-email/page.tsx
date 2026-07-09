import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepsFor, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import OnboardingShell from '@/components/onboarding/OnboardingShell';
import VerifyEmailStepClient from './VerifyEmailStepClient';

// ─── Step: verify email OTP ────────────────────────────────────────────
//
// Email-signup path only. Google patients arrive with email_confirmed_at
// already set, so the router at /onboarding never sends them here.
// Direct-URL access checks the current state and forwards away if the
// step doesn't apply.

export const dynamic = 'force-dynamic';

export default async function VerifyEmailStep() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding');

  const { data: profile } = await supabase
    .from('profiles')
    .select('email, phone_verified_at, sa_id_number, salary_day, credit_check_status, liveness_verified_at, onboarding_completed')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile) redirect('/dashboard');

  const p = profile as ProfileForOnboarding & { email: string | null };
  const flags = currentFlags();
  const userForState = { email_confirmed_at: user.email_confirmed_at ?? null };
  const status = computeOnboarding(userForState, p, flags);

  if (status.done || status.step !== 'verify-email') {
    redirect('/onboarding');
  }

  const steps = stepsFor(userForState, flags);
  const currentIndex = steps.indexOf('verify-email') + 1;

  return (
    <OnboardingShell
      currentIndex={currentIndex}
      total={steps.length}
      title="Verify your email"
      description="We sent a 6-digit code to your email. Enter it below to continue."
    >
      <VerifyEmailStepClient email={profile.email as string} />
    </OnboardingShell>
  );
}
