import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepListFor, type ProfileForOnboarding, type UserForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import { requireTermsAccepted } from '@/lib/legal/termsGate';
import OnboardingShell from '@/components/onboarding/OnboardingShell';
import SalaryStepClient from './SalaryStepClient';

// ─── Step: salary day + amount ─────────────────────────────────────────
//
// Split out of the old combined identity+salary step, which asked for a
// government ID, biometric consent, a pay date and an income figure on
// one screen under a single step label.
//
// Runs BEFORE identity: this is a plain synchronous form, whereas
// identity redirects off-site to Didit and resolves asynchronously via
// webhook. Ordering the synchronous work first means the patient never
// has to come back to an input after verifying.
//
// Credit-check SEAM: saveSalaryDetails' server code auto-passes the
// credit check when ENABLE_CREDIT_CHECK is off (writes
// credit_check_status='passed'). When on, credit_check_status stays NULL
// and the router forwards to /onboarding/credit-check after identity.

export const dynamic = 'force-dynamic';

export default async function SalaryStep() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, phone_verified_at, sa_id_number, salary_day, salary_amount, credit_check_status, liveness_verified_at, onboarding_completed, terms_accepted_at')
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

  // Same guard every other step uses: if the computation says the
  // patient belongs elsewhere, send them there rather than rendering a
  // step they have already completed or cannot yet reach.
  if (status.done || status.step !== 'salary') {
    redirect('/onboarding');
  }

  const steps = stepListFor(userForState, flags);

  return (
    <OnboardingShell
      steps={steps}
      currentStep="salary"
      title="Your income"
      description="When you're paid and roughly what you earn — we use this to run an affordability check and to time instalments to your salary."
    >
      <SalaryStepClient
        salaryDay={p.salary_day}
        salaryAmount={p.salary_amount}
      />
    </OnboardingShell>
  );
}
