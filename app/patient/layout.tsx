import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PatientNav from './PatientNav';
import PatientBottomNav from './PatientBottomNav';
import LogoutButton from './LogoutButton';

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
    <div className="min-h-screen bg-[#f7fbfb] flex flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-20 shrink-0" style={{ background: 'linear-gradient(135deg, #13294B 0%, #0E2140 100%)' }}>
        <div className="relative flex items-center justify-between px-4 sm:px-6 h-16">
          <div className="w-9" />
          <span className="absolute left-1/2 -translate-x-1/2 text-base font-semibold tracking-wide select-none">
            <span style={{ color: '#fff', fontWeight: 400 }}>better</span><span style={{ color: '#15A89E', fontWeight: 700 }}>now</span>
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
    </div>
  );
}
