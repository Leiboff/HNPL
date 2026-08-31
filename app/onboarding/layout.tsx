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
// background so route-level redirects don't flash on top of the
// wrong bg.
//
// That background is the DEEP NAVY the auth surface starts from
// (--auth-ground-from / --navy-deep), not the app's pale teal-white:
// every screen under this tree renders inside <AuthSurface> via
// OnboardingShell, and a pale layout behind a navy screen shows as a
// white flash on every step transition. Written as a literal rather
// than the token because the token lives on .auth-surface, which is a
// descendant of this element, not an ancestor.

export const dynamic = 'force-dynamic';

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0E2140] flex flex-col">
      {children}
    </div>
  );
}
