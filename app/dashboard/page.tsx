import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';

export default async function DashboardPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/dashboard' });

  const { data: profile, error } = await supabase
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
    case 'practice_provider':
      redirect('/provider');
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
