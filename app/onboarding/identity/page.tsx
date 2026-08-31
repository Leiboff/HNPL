import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepListFor, type ProfileForOnboarding, type UserForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import { requireTermsAccepted } from '@/lib/legal/termsGate';
import OnboardingShell from '@/components/onboarding/OnboardingShell';
import IdentityStepClient from './IdentityStepClient';

// ─── Step: identity verification ───────────────────────────────────────
//
// Every patient sees this step. It does ONE thing: take the SA ID and
// consent, then start verification. The salary day/amount form that used
// to share this screen is now its own step at /onboarding/salary, which
// runs first.
//
// The patient types their SA ID; the server fetches their portrait from
// the identity registry and creates a Didit session that proves liveness
// and face-matches the selfie against that portrait. This page only
// STARTS the session and redirects to Didit's hosted URL — the decision
// is applied asynchronously by
// app/api/verification/didit/webhook/route.ts, which is the ONLY place
// sa_id_number gets written.

export const dynamic = 'force-dynamic';

type Props = {
  searchParams: Promise<{ didit?: string }>;
};

export default async function IdentityStep({ searchParams }: Props) {
  const params = await searchParams;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, phone_verified_at, sa_id_number, salary_day, salary_amount, credit_check_status, liveness_verified_at, onboarding_completed, terms_accepted_at, identity_verification_status, identity_verification_reason')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile) redirect('/dashboard');

  // Acceptance is a precondition of the account, so it is checked
  // BEFORE any step renders — not assumed because an upstream route was
  // supposed to have enforced it. See lib/legal/termsGate.ts.
  requireTermsAccepted(profile);

  const p = profile as ProfileForOnboarding;
  const flags = currentFlags();
  const userForState: UserForOnboarding = {
    email_confirmed_at: user.email_confirmed_at ?? null,
    identity_providers: (user.identities ?? []).map((i) => i.provider),
  };
  const status = computeOnboarding(userForState, p, flags);

  if (status.done || status.step !== 'identity') {
    redirect('/onboarding');
  }

  const steps = stepListFor(userForState, flags);

  return (
    <OnboardingShell
      steps={steps}
      currentStep="identity"
      title="Verify your identity"
      // Copy deliberately describes what NOW happens: the patient enters
      // their ID number and takes a selfie. There is no document scan —
      // the reference photo comes from the identity registry, not from a
      // photograph of an ID card.
      description="Enter your SA ID number and take a quick selfie. We'll check it against your official identity photo to confirm it's really you."
    >
      <IdentityStepClient
        identityVerificationStatus={(profile as { identity_verification_status: string | null }).identity_verification_status}
        identityVerificationReason={(profile as { identity_verification_reason: string | null }).identity_verification_reason}
        returningFromDidit={params.didit === 'callback'}
      />
    </OnboardingShell>
  );
}
