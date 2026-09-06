import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import LogoutButton from '@/app/dashboard/LogoutButton';
import AdminNav from './AdminNav';
import { getAdminNavCounts } from './adminNavCounts';
import AdminPortalMenu from './AdminPortalMenu';
import InactivityGuard from '@/lib/auth/InactivityGuard';
import { getRequestUser } from '@/lib/auth/requestUser';

// Persistent shell for every /admin/* route: sticky top bar with brand +
// logout, desktop left sidebar, and — on a phone — a hamburger menu in
// that top bar. Badge counts (pending practices, overdue collections,
// pending payouts) are fetched once here and threaded into both nav
// variants, which render the same link list from ./adminNavLinks.
//
// The phone nav used to be a five-slot floating bottom bar, which could
// not fit the portal's ten destinations; the hamburger has no such
// ceiling, so mobile now reaches everything desktop does.
//
// Layout-level admin authorization runs first; individual /admin/* pages
// still keep their own auth checks as belt-and-braces (consistent with
// the patient portal pattern).

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Read-only and cache()-memoised per request, so this is free on
  // pages that already resolve the user. Not a gate — each page keeps
  // its own auth check and redirect target.
  const guardUser = await getRequestUser();

  const { user, supabase } = await requireConfirmedUser({ next: '/admin' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                              redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                               redirect('/provider');
    else                                                                          redirect('/login');
  }

  // Badge counts for both nav surfaces. Shared with the CRM shell, which
  // renders the same menu for admins — see ./adminNavCounts.
  const counts = await getAdminNavCounts(supabase);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* ── Sticky top bar ─────────────────────────────────────────── */}
      {/* `sticky` positions this bar, which also makes it the containing
          block for the mobile menu's absolutely-positioned dropdown — so
          the panel spans the full width of the bar rather than hanging off
          the hamburger button. Do not swap it for `static`. */}
      <header className="sticky top-0 z-20 shrink-0 bg-white border-b border-gray-200">
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5">
          <Link href="/admin" className="flex items-center gap-2">
            <span
              className="text-lg font-semibold tracking-tight"
              style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
            >
              <span style={{ color: '#13294B' }}>better</span>
              <span style={{ color: '#15A89E' }}>now</span>
            </span>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide border border-gray-200 rounded px-1.5 py-0.5">
              Admin
            </span>
          </Link>
          {/* Desktop logs out from here; on a phone "Sign out" is the last
              entry inside the hamburger menu. */}
          <div className="hidden md:block">
            <LogoutButton />
          </div>
          {/* Phone-only here: at md+ the sidebar below carries the same
              links. In the CRM shell, which has no admin sidebar, the same
              menu renders at every width. */}
          <AdminPortalMenu counts={counts} />
        </div>
      </header>

      {/* ── Body: sidebar + page content ──────────────────────────── */}
      <div className="flex flex-row flex-1">
        <AdminNav counts={counts} />
        {/* min-w-0 prevents children from forcing horizontal overflow. The
            old pb-28 is gone with the floating bottom bar it reserved space
            for — nothing overlaps the bottom of the page now. */}
        <main className="flex-1 min-w-0">
          {children}
        </main>
      </div>

      {/* Inactivity auto-logout — admin tuning: warn at 10 min idle,
          log out 10 min later (20 min total). */}
      {/* sessionStartedAt: discards activity persisted by a PREVIOUS
          session, which would otherwise sign this one out the instant it
          starts. See InactivityGuardProps. */}
      <InactivityGuard
        minutesIdle={10}
        minutesWarn={5}
        sessionStartedAt={Date.parse(guardUser?.last_sign_in_at ?? '')}
      />
    </div>
  );
}
