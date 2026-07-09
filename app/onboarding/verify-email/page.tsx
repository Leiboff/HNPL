import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepsFor, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import OnboardingShell from '@/components/onboarding/OnboardingShell';
import VerifyEmailStepClient from './VerifyEmailStepClient';

// ─── Step: verify email OTP ────────────────────────────────────────────
//
// Reachable in two states:
//
//   1. Pre-session (fresh email signup): Supabase's signUp with email
//      confirmation returns no session. The signup form redirects here
//      with ?email=<address>. We render the OTP form using that email;
//      after verifyOtp succeeds the SSR cookies get set and the form
//      hard-navigates to /onboarding (which forwards to the next step).
//
//   2. Post-session (edge case): an already-authenticated patient who
//      hasn't verified email lands here via the routing gate. We use
//      their session email and route them out if verify-email is
//      already done.
//
// Progress bar total: the email path always has (verify-email, phone,
// identity) + any flag-on steps. Since we KNOW we're the email path
// here (Google users have email_confirmed_at set at OAuth link time
// and never see this route), we can compute the total from flags
// without needing the user object.

export const dynamic = 'force-dynamic';

type Props = {
  searchParams: Promise<{ email?: string }>;
};

export default async function VerifyEmailStep({ searchParams }: Props) {
  const params = await searchParams;
  const flags = currentFlags();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Authenticated branch — normal state-model check + redirect-if-done.
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('email, phone_verified_at, sa_id_number, salary_day, credit_check_status, liveness_verified_at, onboarding_completed')
      .eq('id', user.id)
      .maybeSingle();
    if (!profile) redirect('/dashboard');

    const p = profile as ProfileForOnboarding & { email: string | null };
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
        <VerifyEmailStepClient email={(profile.email as string) ?? user.email ?? ''} />
      </OnboardingShell>
    );
  }

  // Pre-session branch — the fresh-signup landing. Must have an
  // ?email= param; otherwise the caller has no idea whose OTP to
  // verify, so send them to /login as a safe fallback.
  const emailParam = params.email?.trim();
  if (!emailParam) redirect('/login');

  // Email path always has these three base steps + any flag-on steps.
  // We know the caller is on the email path (Google users have
  // email_confirmed_at already so the router never sends them here).
  const totalSteps = 3 + (flags.creditCheck ? 1 : 0) + (flags.liveness ? 1 : 0);

  return (
    <OnboardingShell
      currentIndex={1}
      total={totalSteps}
      title="Verify your email"
      description="We sent a 6-digit code to your email. Enter it below to continue."
    >
      <VerifyEmailStepClient email={emailParam} />
    </OnboardingShell>
  );
}
