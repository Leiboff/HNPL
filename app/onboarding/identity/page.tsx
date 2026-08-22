import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepListFor, type ProfileForOnboarding, type UserForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import OnboardingShell from '@/components/onboarding/OnboardingShell';
import IdentityStepClient from './IdentityStepClient';

// ─── Step: identity (Didit verification) + salary details ─────────────
//
// Every patient sees this step. Two independent pieces, completable in
// either order — the step is satisfied once both have landed:
//
//   • Salary day + amount — captured directly here (saveSalaryDetails).
//   • The SA ID itself, plus liveness — captured by a Didit-hosted
//     session (OCR document scan + liveness + face match). This page
//     only starts the session (startIdentityVerification) and redirects
//     to Didit's hosted URL; the decision is applied asynchronously by
//     app/api/verification/didit/webhook/route.ts, which is the ONLY
//     place sa_id_number gets written now.
//
// Credit-check SEAM: saveSalaryDetails' server code auto-passes the
// credit check when ENABLE_CREDIT_CHECK is off (writes
// credit_check_status='passed'). When on, credit_check_status stays
// NULL and the router forwards to /onboarding/credit-check next.

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
    .select('phone_verified_at, sa_id_number, salary_day, salary_amount, credit_check_status, liveness_verified_at, onboarding_completed, identity_verification_status, identity_verification_reason')
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

  if (status.done || status.step !== 'identity') {
    redirect('/onboarding');
  }

  const steps = stepListFor(userForState, flags);

  return (
    <OnboardingShell
      steps={steps}
      currentStep="identity"
      title="Verify your identity"
      description="We'll scan your SA ID and take a quick selfie to confirm it's you, plus your monthly income to run a quick affordability check and time instalments to your salary."
    >
      <IdentityStepClient
        salaryDay={p.salary_day}
        salaryAmount={p.salary_amount}
        identityVerificationStatus={(profile as { identity_verification_status: string | null }).identity_verification_status}
        identityVerificationReason={(profile as { identity_verification_reason: string | null }).identity_verification_reason}
        returningFromDidit={params.didit === 'callback'}
      />
    </OnboardingShell>
  );
}
