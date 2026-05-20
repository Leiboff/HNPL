import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import LogoutButton from '@/app/dashboard/LogoutButton';

export default async function PatientDashboardPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

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
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between">
          <span className="text-lg font-semibold text-gray-900">HNPL</span>
          <LogoutButton />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="text-3xl font-semibold text-gray-900">
          Patient Dashboard
        </h1>
        <p className="mt-2 text-gray-500">
          Welcome, {profile?.first_name ?? user.email}
        </p>
      </main>
    </div>
  );
}
