import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { computeOnboarding, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';
import { ONBOARDING_ADVANCE_COOKIE, isDraftExpired, maskEmail, maskPhone } from '@/lib/onboarding/draft';
import WelcomeBackInterstitial from '@/components/onboarding/WelcomeBackInterstitial';

// ─── Onboarding router ────────────────────────────────────────────────
//
// The single URL an incomplete patient is ever sent to. We compute
// the first unfinished step and forward. If they're done (satisfies
// every applicable step but the cached flag isn't set yet — e.g. mid-
// migration) we finalize here + send them to /patient.
//
// Draft-resume gate: an incomplete patient with an EXISTING in-progress
// draft (onboarding_last_active_at already set on a prior request) only
// gets forwarded straight to their next step when the short-lived
// "just advanced" cookie proves this load is a direct continuation of
// the step they just finished. Otherwise — a fresh top-level entry into
// the tree with progress already on file — we render the "Welcome back"
// interstitial instead of silently dropping them back into a mid-flow
// step. See lib/onboarding/draft.ts for the cookie + expiry rules.

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
    .select('role, email, phone, phone_verified_at, sa_id_number, salary_day, credit_check_status, liveness_verified_at, onboarding_completed, onboarding_last_active_at')
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
    // The transition to completed is the ONE moment we show the
    // completion welcome — flag it with ?welcome=1 so the dashboard
    // greets first-run patients without ever showing that copy to
    // returning ones (who take the plain redirect below).
    if (!p.onboarding_completed) {
      await service
        .from('profiles')
        .update({
          onboarding_completed:    true,
          onboarding_completed_at: new Date().toISOString(),
        })
        .eq('id', user.id);
      redirect('/patient?welcome=1');
    }
    redirect('/patient');
  }

  // ─── Draft-resume gate ────────────────────────────────────────────
  const lastActiveAt = profile.onboarding_last_active_at as string | null;

  if (lastActiveAt === null) {
    // The draft is born right now — this is the first time this patient
    // has ever reached verified contact with progress to track. Nothing
    // to resume yet, so there's nothing to confirm; stamp the clock and
    // go straight to the first real step.
    await service
      .from('profiles')
      .update({ onboarding_last_active_at: new Date().toISOString() })
      .eq('id', user.id);
    redirect(status.path);
  }

  const cookieStore  = await cookies();
  const justAdvanced = cookieStore.get(ONBOARDING_ADVANCE_COOKIE)?.value === user.id;

  if (justAdvanced) {
    // Direct continuation of the step this patient just finished in the
    // same sitting — the step action already stamped the activity clock.
    redirect(status.path);
  }

  // A fresh top-level entry into the tree with an existing in-progress
  // draft and NO "just advanced" signal — i.e. they left and came back.
  // NEVER silently forward from here; show the explicit confirmation
  // interstitial instead, gated by re-displaying the verified contact
  // the draft belongs to so a different person on a shared device sees
  // whose draft this is before anything resumes.
  return (
    <WelcomeBackInterstitial
      expired={isDraftExpired(lastActiveAt)}
      maskedEmail={maskEmail(profile.email as string | null)}
      maskedPhone={profile.phone_verified_at ? maskPhone(profile.phone as string | null) : null}
    />
  );
}
