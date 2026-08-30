import Link from 'next/link';
import { requireSalesOrAdmin } from '@/lib/auth/requireSalesOrAdmin';
import LogoutButton from '@/app/dashboard/LogoutButton';
import InactivityGuard from '@/lib/auth/InactivityGuard';
import { getRequestUser } from '@/lib/auth/requestUser';
import CrmNav from './CrmNav';
import CrmBottomNav from './CrmBottomNav';
import { sastDayWindows } from '@/lib/crm/timezone';

// ─── /crm/* shell ────────────────────────────────────────────────────
//
// Sales-and-admin-scoped area. The layout-level gate (requireSalesOrAdmin)
// runs first; individual pages repeat the check per the belt-and-braces
// pattern enforced by crm-routes-auth.test.ts.
//
// Badge count: number of leads with an overdue follow-up (in SAST). One
// query per layout render; pages under it inherit the same figure so
// the sidebar and mobile nav agree without re-querying.

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  // Read-only and cache()-memoised per request, so this is free on
  // pages that already resolve the user. Not a gate — each page keeps
  // its own auth check and redirect target.
  const guardUser = await getRequestUser();

  const { supabase, role } = await requireSalesOrAdmin({ next: '/crm' });
  const isAdmin = role === 'admin';

  const { todayStartUtc } = sastDayWindows(new Date());

  const { count: overdueFollowups } = await supabase
    .from('crm_leads')
    .select('id', { count: 'exact', head: true })
    .is('archived_at', null)
    .lt('next_follow_up_at', todayStartUtc.toISOString())
    .not('next_follow_up_at', 'is', null)
    .not('stage', 'in', '(signed,onboarded,lost)');

  const counts = { overdueFollowups: overdueFollowups ?? 0 };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="sticky top-0 z-20 shrink-0 bg-white border-b border-gray-200">
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5">
          <Link href="/crm" className="flex items-center gap-2">
            <span
              className="text-lg font-semibold tracking-tight"
              style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
            >
              <span style={{ color: '#13294B' }}>better</span>
              <span style={{ color: '#15A89E' }}>now</span>
            </span>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide border border-gray-200 rounded px-1.5 py-0.5">
              CRM
            </span>
          </Link>
          <LogoutButton />
        </div>
      </header>

      <div className="flex flex-row flex-1">
        <CrmNav counts={counts} isAdmin={isAdmin} />
        <main className="flex-1 min-w-0 pb-28 md:pb-0">
          {children}
        </main>
      </div>

      <CrmBottomNav counts={counts} />

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
