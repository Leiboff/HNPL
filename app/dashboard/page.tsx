import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import LogoutButton from './LogoutButton';

export default async function DashboardPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name, email, role')
    .eq('id', user.id)
    .single();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between">
          <span className="text-lg font-semibold text-gray-900">HNPL</span>
          <LogoutButton />
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="text-3xl font-semibold text-gray-900 mb-8">
          Welcome, {profile?.first_name ?? user.email}
        </h1>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm divide-y divide-gray-100">
          <div className="px-6 py-4 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-500">
              Account type
            </span>
            <span className="text-sm text-gray-900 capitalize">
              {profile?.role?.replace('_', ' ') ?? '—'}
            </span>
          </div>
          <div className="px-6 py-4 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-500">Email</span>
            <span className="text-sm text-gray-900">
              {profile?.email ?? user.email}
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
