import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatDateStr } from '../_lib/format';
import SalesTeamClient from './SalesTeamClient';

// ─── /admin/sales-team ────────────────────────────────────────────────
//
// Platform admins add/remove people from the sales team. Assigning
// role='sales' opens up /crm; nothing else. Layout runs the admin gate
// first; this page repeats it (belt-and-braces per the admin-routes-
// auth regression pin).

export default async function SalesTeamPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/sales-team' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  const { data: salesUsers } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, email, created_at')
    .eq('role', 'sales')
    .order('created_at', { ascending: false })
    .limit(200);

  const rows = (salesUsers ?? []).map(u => ({
    id:          u.id,
    name:        [u.first_name, u.last_name].filter(Boolean).join(' ') || '—',
    email:       u.email,
    createdAt:   formatDateStr(u.created_at.slice(0, 10)),
  }));

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Sales team</h1>
        <p className="mt-1 text-sm text-gray-500">
          Grant the &lsquo;sales&rsquo; role to an existing user. Sales users can access the CRM
          — nothing else on the platform admin surface (no approvals, no banking,
          no patient data). Users must already have an account before you can
          promote them; ask them to sign up first.
        </p>
      </div>

      <SalesTeamClient existing={rows} />
    </div>
  );
}
