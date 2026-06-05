import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PatientNav from './PatientNav';
import SettingsSheet from './SettingsSheet';

export default async function PatientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name, last_name, email, phone')
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

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-20 shrink-0" style={{ backgroundColor: '#0F4C75' }}>
        <div className="relative flex items-center justify-between px-4 sm:px-6 h-16">
          {/* Left spacer (balances the gear on the right) */}
          <div className="w-9" />
          {/* Centered wordmark */}
          <span className="absolute left-1/2 -translate-x-1/2 text-base font-semibold text-white tracking-wide select-none">
            BetterNow
          </span>
          {/* Right: gear / settings */}
          <SettingsSheet
            firstName={profile?.first_name ?? ''}
            lastName={profile?.last_name ?? ''}
            email={profile?.email ?? ''}
            phone={profile?.phone ?? ''}
          />
        </div>
      </header>

      {/* Body: sidebar + page content, responsive */}
      <div className="flex flex-col md:flex-row flex-1">
        <PatientNav />
        <main className="flex-1 min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
