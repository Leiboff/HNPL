import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeOnboarding, stepListFor, type ProfileForOnboarding, type UserForOnboarding } from '@/lib/onboarding/state';
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
//      Path-fixed step list computed with a synthetic ['email']
//      identity so pre-session and post-session totals match exactly.
//
//   2. Post-session (edge case): an already-authenticated patient who
//      hasn't verified email lands here via the routing gate. We use
//      their real user.identities + session email and route them out
//      if verify-email is already done.

export const dynamic = 'force-dynamic';

type Props = {
  searchParams: Promise<{ email?: string }>;
};

// Pre-session synthetic user: we KNOW this branch is only reachable by
// email signups (Google users have email_confirmed_at set at OAuth link
// time and never see this route). Hardcode ['email'] so stepListFor
// yields the same list an authenticated email-path user would see.
const PRE_SESSION_EMAIL_USER: UserForOnboarding = {
  email_confirmed_at: null,
  identity_providers: ['email'] as const,
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
      .select('email, terms_accepted_at, phone_verified_at, sa_id_number, salary_day, salary_amount, credit_check_status, liveness_verified_at, onboarding_completed')
      .eq('id', user.id)
      .maybeSingle();
    if (!profile) redirect('/dashboard');

    const p = profile as ProfileForOnboarding & { email: string | null };
    const userForState: UserForOnboarding = {
      email_confirmed_at: user.email_confirmed_at ?? null,
      identity_providers: (user.identities ?? []).map((i) => i.provider),
    };
    const status = computeOnboarding(userForState, p, flags);
    if (status.done || status.step !== 'verify-email') {
      redirect('/onboarding');
    }

    const steps = stepListFor(userForState, flags);

    return (
      <OnboardingShell
        steps={steps}
        currentStep="verify-email"
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

  // Same list length as the authenticated email-path branch — the
  // shared stepListFor + synthetic PRE_SESSION_EMAIL_USER guarantee
  // the two totals cannot drift.
  const steps = stepListFor(PRE_SESSION_EMAIL_USER, flags);

  return (
    <OnboardingShell
      steps={steps}
      currentStep="verify-email"
      title="Verify your email"
      description="We sent a 6-digit code to your email. Enter it below to continue."
    >
      <VerifyEmailStepClient email={emailParam} />
    </OnboardingShell>
  );
}
