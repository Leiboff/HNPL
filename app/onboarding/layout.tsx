// ─── Onboarding layout — no-auth wrapper ───────────────────────────────
//
// This layout deliberately does NOT require authentication. Reason:
// /onboarding/verify-email must be reachable pre-session — Supabase's
// email-confirmation flow returns no session until verifyOtp succeeds,
// so the OTP page has to render for an anonymous browser holding just
// an ?email=<address> query param.
//
// Every step page under /onboarding/**/page.tsx runs its own
// requireConfirmedUser (or an equivalent no-session-required check
// for verify-email) so security stays at the route level, not the
// layout. The layout's job is only to give the tree a consistent
// light background so route-level redirects don't flash on top of
// the wrong bg.

export const dynamic = 'force-dynamic';

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#f7fbfb] flex flex-col">
      {children}
    </div>
  );
}
