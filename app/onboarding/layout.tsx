import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';

// ─── Onboarding layout — authenticated patients only ──────────────────
//
// Intentionally does NOT enforce the onboarding-complete gate itself
// (that would loop forever — the routes UNDER this layout ARE the
// completion path). Every /onboarding/* page runs on top of:
//   • a confirmed auth session (bounces to /login / /verify-email
//     otherwise);
//   • profile.role === 'patient' (staff / admins are dispatched away
//     from onboarding — they're never in this flow).
//
// The routing decision to SEND a patient here lives in the patient
// layout ([app/patient/layout.tsx]) — this file just makes the flow
// safe to land in.

export const dynamic = 'force-dynamic';

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, supabase } = await requireConfirmedUser({ next: '/onboarding' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  // Non-patients don't have an onboarding flow; dispatch them.
  if (profile?.role && profile.role !== 'patient') {
    redirect('/dashboard');
  }

  return (
    <div className="min-h-screen bg-[#f7fbfb] flex flex-col">
      {children}
    </div>
  );
}
