import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import NewLeadForm from './NewLeadForm';

export default async function NewLeadPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/crm/leads/new' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'sales' && profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-8">
      <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">New lead</h1>
      <p className="mt-1 text-sm text-gray-500">
        Capture a practice you&apos;re working. Address search uses Google Places — we&apos;ll pull suburb + city + province + coords automatically.
      </p>
      <NewLeadForm />
    </div>
  );
}
