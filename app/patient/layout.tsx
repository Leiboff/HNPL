import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import LogoutButton from '@/app/dashboard/LogoutButton';
import PatientNav from './PatientNav';

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
    .select('role, first_name')
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
      <header className="bg-white border-b border-gray-200 sticky top-0 z-20 shrink-0">
        <div className="flex items-center justify-between px-4 sm:px-6 h-14">
          <span className="text-base font-semibold text-gray-900">BetterNow</span>
          <div className="flex items-center gap-3">
            {profile?.first_name && (
              <span className="text-sm text-gray-500 hidden sm:inline">
                {profile.first_name}
              </span>
            )}
            <LogoutButton />
          </div>
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
