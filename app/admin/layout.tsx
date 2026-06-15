import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import LogoutButton from '@/app/dashboard/LogoutButton';
import AdminNav from './AdminNav';
import AdminBottomNav from './AdminBottomNav';

// Persistent shell for every /admin/* route — mirrors the patient
// portal: sticky top bar with brand + logout, desktop left sidebar,
// mobile bottom nav. Badge counts (pending practices, outstanding
// refunds) are fetched once here and threaded into both nav variants.
//
// Layout-level admin authorization runs first; individual /admin/* pages
// still keep their own auth checks as belt-and-braces (consistent with
// the patient portal pattern).

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
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

  const [
    { count: pendingPractices },
    { count: outstandingRefunds },
  ] = await Promise.all([
    supabase.from('practices').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase
      .from('refunds')
      .select('*', { count: 'exact', head: true })
      .in('status', ['initiated', 'pending'])
      .lt('initiated_at', new Date(Date.now() - 60 * 60 * 1000).toISOString()),
  ]);

  const counts = {
    pendingPractices:   pendingPractices ?? 0,
    outstandingRefunds: outstandingRefunds ?? 0,
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* ── Sticky top bar ─────────────────────────────────────────── */}
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
          <LogoutButton />
        </div>
      </header>

      {/* ── Body: sidebar + page content ──────────────────────────── */}
      <div className="flex flex-row flex-1">
        <AdminNav counts={counts} />
        {/* pb-28 on mobile reserves space for the floating bottom-nav.
            min-w-0 prevents children from forcing horizontal overflow. */}
        <main className="flex-1 min-w-0 pb-28 md:pb-0">
          {children}
        </main>
      </div>

      {/* ── Mobile bottom nav ─────────────────────────────────────── */}
      <AdminBottomNav counts={counts} />
    </div>
  );
}
