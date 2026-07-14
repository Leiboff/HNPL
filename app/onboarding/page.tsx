import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { computeOnboarding, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';

// ─── Onboarding router ────────────────────────────────────────────────
//
// The single URL an incomplete patient is ever sent to. We compute
// the first unfinished step and forward. If they're done (satisfies
// every applicable step but the cached flag isn't set yet — e.g. mid-
// migration) we finalize here + send them to /patient.

export const dynamic = 'force-dynamic';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export default async function OnboardingRouter() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding');

  const service = svc();
  const { data: profile } = await service
    .from('profiles')
    .select('role, phone_verified_at, sa_id_number, salary_day, credit_check_status, liveness_verified_at, onboarding_completed')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile) {
    // Trigger hasn't run yet — bounce to /dashboard which will settle
    // this on its next request (the auth-callback belt-and-braces
    // handles fresh Google users; email users always have a profile).
    redirect('/dashboard');
  }

  // Non-patient roles never belong in patient onboarding. A sales
  // user promoted from a stale patient profile could otherwise be
  // dragged through phone / ID / credit steps that don't apply to
  // them. Hand off to the role dispatcher.
  if (profile.role && profile.role !== 'patient') {
    redirect('/dashboard');
  }

  const p = profile as ProfileForOnboarding;
  const status = computeOnboarding(
    {
      email_confirmed_at: user.email_confirmed_at ?? null,
      identity_providers: (user.identities ?? []).map((i) => i.provider),
    },
    p,
    currentFlags(),
  );

  if (status.done) {
    // Cache the flag if it isn't already set (e.g. migration backfill
    // missed this row) so the routing gate never sends them here again.
    if (!p.onboarding_completed) {
      await service
        .from('profiles')
        .update({
          onboarding_completed:    true,
          onboarding_completed_at: new Date().toISOString(),
        })
        .eq('id', user.id);
    }
    redirect('/patient');
  }

  redirect(status.path);
}
