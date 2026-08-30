import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import LogoutButton from '@/app/dashboard/LogoutButton';
import InactivityGuard from '@/lib/auth/InactivityGuard';
import { getRequestUser } from '@/lib/auth/requestUser';

export default async function ProviderLayout({ children }: { children: React.ReactNode }) {
  // Read-only and cache()-memoised per request, so this is free on
  // pages that already resolve the user. Not a gate — each page keeps
  // its own auth check and redirect target.
  const guardUser = await getRequestUser();

  // Defense-in-depth: bounce to /login when no session, /verify-email when
  // session exists but the email is still unconfirmed.
  const { user, supabase } = await requireConfirmedUser({ next: '/provider' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name, last_name')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_provider') {
    if (profile?.role === 'patient')       redirect('/patient');
    if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    if (profile?.role === 'admin')         redirect('/admin');
    redirect('/login');
  }

  const name = profile ? `${profile.first_name} ${profile.last_name}` : user.email;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-6 py-3 flex items-center justify-between">
          <span className="text-lg font-bold" style={{ color: '#0F4C75' }}>BetterNow</span>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600">{name}</span>
            <LogoutButton />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-8 flex gap-8">
        <nav className="w-48 shrink-0">
          <ul className="space-y-1">
            {[
              { href: '/provider',         label: 'Dashboard' },
              { href: '/provider/profile', label: 'My profile' },
            ].map(({ href, label }) => (
              <li key={href}>
                <Link
                  href={href}
                  className="block rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <main className="flex-1 min-w-0">{children}</main>
      </div>

      {/* Inactivity auto-logout — provider tuning: warn at 10 min idle,
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
