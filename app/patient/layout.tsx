import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { getRequestUser } from '@/lib/auth/requestUser';
import PatientNav from './PatientNav';
import PatientBottomNav from './PatientBottomNav';
import InstallPrompt from '@/app/_pwa/InstallPrompt';
import PostLoginPasskeyPrompt from './PostLoginPasskeyPrompt';
import InactivityGuard from '@/lib/auth/InactivityGuard';
import { computeOnboarding, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { getPatientProfileForRequest } from '@/lib/patient/requestProfile';
import { currentFlags } from '@/lib/featureFlags';

export default async function PatientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Defense-in-depth: bounce to /login when no session, /verify-email when
  // session exists but the email is still unconfirmed.
  const { user, supabase } = await requireConfirmedUser({ next: '/patient' });
  // requireConfirmedUser narrows its user to the four fields it needs, so
  // last_sign_in_at is not on it. getRequestUser() is the fuller record
  // and is cache()-memoised per request, so this is a map lookup rather
  // than a second round trip.
  const sessionUser = await getRequestUser();

  // Shared with app/patient/page.tsx via React cache(), so this row is read
  // ONCE per request instead of once here and again in the page. See
  // lib/patient/requestProfile.ts — a layout cannot pass props to a page, so
  // request-scoped memoisation is the mechanism available.
  const profile = await getPatientProfileForRequest(user.id);

  if (profile?.role !== 'patient') {
    if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') {
      redirect('/practice');
    } else if (profile?.role === 'admin') {
      redirect('/admin');
    } else if (profile?.role === 'sales') {
      // Sales users often started life as patients (role-promoted
      // profiles). If they hit /patient we send them home to the
      // CRM — never fall through to /login (redirect loop) or into
      // the patient onboarding gate below.
      redirect('/crm');
    } else if (profile?.role === 'practice_provider') {
      redirect('/provider');
    } else {
      redirect('/login');
    }
  }

  // ─── Routing gate: incomplete patients get sent to /onboarding ─────
  //
  // The router at /onboarding computes the first unfinished step and
  // forwards. This layout only decides "onboarding or main app?" —
  // never "which step next?". Google users landing here for the first
  // time (no phone, no ID) hit this branch and get sent to phone step.
  //
  // requireConfirmedUser exposes both email_confirmed_at (guaranteed
  // non-null on this code path) and identity_providers (drives the
  // step-list path decision — email vs Google-only).
  const onboardingStatus = computeOnboarding(
    {
      email_confirmed_at: user.email_confirmed_at,
      identity_providers: user.identity_providers,
    },
    profile as unknown as ProfileForOnboarding,
    currentFlags(),
  );
  if (!onboardingStatus.done) {
    redirect('/onboarding');
  }

  // Post-login passkey prompt frequency cap (0065). The client
  // component's own gate hides the prompt if the user already has a
  // passkey enrolled (Supabase auth.passkey.list on mount) — the
  // server can't check that here without an admin API call. Both
  // gates must pass for the sheet to render.
  const loginCount              = (profile?.login_count as number | null) ?? 0;
  const nextShowAt              = (profile?.passkey_prompt_next_show_at_login as number | null) ?? 1;
  const permanentlyDismissed    = (profile?.passkey_prompt_permanent_dismiss  as boolean | null) ?? false;
  const serverAllowsPasskeyPrompt =
    !permanentlyDismissed && loginCount >= nextShowAt;

  return (
    <div className="min-h-screen bg-[#F4F7F8] flex flex-col">
      {/* v4: no global top bar. Each screen renders its own navy header
          (PatientScreen) that runs to the top edge; the Action Centre bell
          lives inside the Home hero. Desktop keeps the sidebar. */}

      {/* Body: sidebar + page content */}
      <div className="flex flex-row flex-1">
        <PatientNav />
        {/* pb-28 on mobile leaves room for the floating bottom nav */}
        <main className="flex-1 min-w-0 pb-28 md:pb-0">
          {children}
        </main>
      </div>

      {/* Floating bottom nav — mobile only */}
      <PatientBottomNav />

      {/* PWA install affordance — shows once, respects dismissal. iOS
          Safari gets the share-then-Add-to-Home-Screen hint; Android
          Chrome gets a real Install button driven by beforeinstallprompt. */}
      <InstallPrompt />

      {/* Post-login passkey prompt (0065). Full-sheet, skippable,
          frequency-capped. Client component self-hides when the user
          already has a passkey. */}
      <PostLoginPasskeyPrompt serverAllows={serverAllowsPasskeyPrompt} />

      {/* Inactivity auto-logout — patient tuning: warn at 5 min idle,
          log out 5 min later (10 min total). */}
      {/* sessionStartedAt: see the note on InactivityGuardProps — it
          discards activity persisted by a previous session, which would
          otherwise sign this one out the instant it starts. */}
      <InactivityGuard
        minutesIdle={5}
        minutesWarn={5}
        sessionStartedAt={Date.parse(sessionUser?.last_sign_in_at ?? '')}
      />
    </div>
  );
}
