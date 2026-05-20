import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export default async function DashboardPage() {
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

  switch (profile?.role) {
    case 'patient':
      redirect('/patient');
    case 'practice_admin':
    case 'practice_staff':
      redirect('/practice');
    case 'admin':
      redirect('/admin');
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <p className="text-gray-600 text-sm">
        Account setup incomplete. Please contact support.
      </p>
    </div>
  );
}
