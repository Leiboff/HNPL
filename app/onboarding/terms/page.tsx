import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepListFor, type ProfileForOnboarding, type UserForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import OnboardingShell from '@/components/onboarding/OnboardingShell';
import TermsStepClient from './TermsStepClient';

// ─── Step: agree to the terms (OAuth paths only) ───────────────────────
//
// An email signup ticks "I agree" inside the signup form, gated
// server-side in signUpPatient before the account is created. A Google
// signup has no such moment: the OAuth round trip creates the account
// with nothing agreed to.
//
// That gap used to be filled by INFERENCE — a "by continuing you agree"
// line beside the button, with /auth/callback stamping acceptance on
// arrival. Defensible, and much weaker than what the email path does.
// This step is the missing moment made explicit: an unticked box the
// customer has to tick, recorded by a server action that gates on it.
//
// It is FIRST in the Google step list, so the account cannot reach any
// other step — or the rest of the app — without it.

export const dynamic = 'force-dynamic';

export default async function TermsStep() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding');

  const { data: profile } = await supabase
    .from('profiles')
    .select('terms_accepted_at, phone_verified_at, sa_id_number, salary_day, salary_amount, credit_check_status, liveness_verified_at, onboarding_completed')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile) redirect('/dashboard');

  const p = profile as ProfileForOnboarding;
  const flags = currentFlags();
  const userForState: UserForOnboarding = {
    email_confirmed_at: user.email_confirmed_at ?? null,
    identity_providers: (user.identities ?? []).map((i) => i.provider),
  };
  const status = computeOnboarding(userForState, p, flags);

  // Same guard every other step uses: if the computation says the
  // patient belongs elsewhere, send them there. This is also what stops
  // an email-path user reaching a screen that is not in their list, and
  // what stops anyone re-agreeing to something already recorded.
  if (status.done || status.step !== 'terms') {
    redirect('/onboarding');
  }

  const steps = stepListFor(userForState, flags);

  return (
    <OnboardingShell
      steps={steps}
      currentStep="terms"
      title="Terms & conditions"
      description="Before we set up your account, please read and agree to how betternow works."
    >
      <TermsStepClient />
    </OnboardingShell>
  );
}
