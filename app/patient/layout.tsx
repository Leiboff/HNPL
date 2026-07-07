import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import PatientNav from './PatientNav';
import PatientBottomNav from './PatientBottomNav';
import LogoutButton from './LogoutButton';
import InstallPrompt from '@/app/_pwa/InstallPrompt';
import PostLoginPasskeyPrompt from './PostLoginPasskeyPrompt';
import InactivityGuard from '@/lib/auth/InactivityGuard';
import { computeOnboarding, type ProfileForOnboarding } from '@/lib/onboarding/state';
import { currentFlags } from '@/lib/featureFlags';

export default async function PatientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Defense-in-depth: bounce to /login when no session, /verify-email when
  // session exists but the email is still unconfirmed.
  const { user, supabase } = await requireConfirmedUser({ next: '/patient' });

  const { data: profile } = await supabase
    .from('profiles')
    .select(`
      role, first_name, last_name, email, phone,
      login_count, passkey_prompt_next_show_at_login, passkey_prompt_permanent_dismiss,
      phone_verified_at, sa_id_number, salary_day,
      credit_check_status, liveness_verified_at, onboarding_completed
    `)
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'patient') {
    if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') {
      redirect('/practice');
    } else if (profile?.role === 'admin') {
      redirect('/admin');
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
  // email_confirmed_at is guaranteed non-null by requireConfirmedUser()
  // above — we synthesise a truthy sentinel so the state model treats
  // the verify-email step as satisfied.
  const onboardingStatus = computeOnboarding(
    { email_confirmed_at: 'confirmed' },
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
    <div className="min-h-screen bg-[#f7fbfb] flex flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-20 shrink-0 bg-white border-b border-gray-200">
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5">
          <span
            className="text-lg font-semibold tracking-tight"
            style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            <span style={{ color: '#13294B' }}>better</span>
            <span style={{ color: '#15A89E' }}>now</span>
          </span>
          <LogoutButton />
        </div>
      </header>

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
      <InactivityGuard minutesIdle={5} minutesWarn={5} />
    </div>
  );
}
