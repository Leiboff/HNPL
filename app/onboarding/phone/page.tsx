import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepsFor, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import OnboardingShell from '../_components/OnboardingShell';
import PhoneStepClient from './PhoneStepClient';

// ─── Step: cell number + phone OTP ────────────────────────────────────
//
// Applies to every patient. Email patients already have profiles.phone
// set from the signup form — the client jumps straight to OTP entry.
// Google patients have no phone on their profile — the client collects
// it, writes via setPhoneForOnboarding, then falls into OTP entry.

export const dynamic = 'force-dynamic';

export default async function PhoneStep() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding');

  const { data: profile } = await supabase
    .from('profiles')
    .select('phone, phone_verified_at, sa_id_number, salary_day, credit_check_status, liveness_verified_at, onboarding_completed')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile) redirect('/dashboard');

  const p = profile as ProfileForOnboarding & { phone: string | null };
  const flags = currentFlags();
  const userForState = { email_confirmed_at: user.email_confirmed_at ?? null };
  const status = computeOnboarding(userForState, p, flags);

  if (status.done || status.step !== 'phone') {
    redirect('/onboarding');
  }

  const steps = stepsFor(userForState, flags);
  const currentIndex = steps.indexOf('phone') + 1;

  return (
    <OnboardingShell
      currentIndex={currentIndex}
      total={steps.length}
      title="Add your cell number"
      description="We'll send a code to confirm it's really you. Standard SMS rates apply."
    >
      <PhoneStepClient existingPhone={(profile.phone as string | null) ?? null} />
    </OnboardingShell>
  );
}
