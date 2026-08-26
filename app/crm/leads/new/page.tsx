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

  // Owner picker is admin-only — RLS only lets a sales user insert a
  // lead owned by themselves (or unowned), so there's nothing for them
  // to pick.
  let owners: Array<{ id: string; name: string }> = [];
  if (profile?.role === 'admin') {
    const { data } = await supabase
      .from('profiles')
      .select('id, first_name, last_name')
      .in('role', ['admin', 'sales'])
      .order('first_name');
    owners = (data ?? []).map(o => ({ id: o.id, name: `${o.first_name} ${o.last_name}`.trim() }));
  }

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-8">
      <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">New lead</h1>
      <p className="mt-1 text-sm text-gray-500">
        Capture a practice you&apos;re working. Address search uses Google Places — we&apos;ll pull suburb + city + province + coords automatically.
      </p>
      <NewLeadForm currentUserId={user.id} isAdmin={profile?.role === 'admin'} owners={owners} />
    </div>
  );
}
