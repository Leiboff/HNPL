import { redirect } from 'next/navigation';
import { requireConfirmedUser } from './requireConfirmedUser';

// ─── requireSalesOrAdmin ─────────────────────────────────────────────────
//
// Gate helper for every /crm/* page. Wraps requireConfirmedUser (so an
// unauthenticated caller is bounced to /login and an unconfirmed one
// to /verify-email) and then enforces `role IN ('sales', 'admin')`.
//
// Matches the belt-and-braces pattern used across /admin: the layout
// runs this check, and each page.tsx repeats it so a future refactor
// that moves a route can't accidentally drop the gate. See the CRM
// counterpart to admin-routes-auth.test.ts (crm-routes-auth.test.ts).
//
// Non-matching roles are redirected to their natural home rather than
// left staring at a blank /crm. Anonymous callers never reach the role
// branch — requireConfirmedUser handles them first.

export async function requireSalesOrAdmin(options: { next?: string } = {}) {
  const { user, supabase } = await requireConfirmedUser({ next: options.next ?? '/crm' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = profile?.role;
  if (role !== 'sales' && role !== 'admin') {
    if (role === 'patient')                                          redirect('/patient');
    else if (role === 'practice_admin' || role === 'practice_staff') redirect('/practice');
    else if (role === 'practice_provider')                           redirect('/provider');
    else                                                             redirect('/login');
  }

  return { user, supabase, role: role as 'sales' | 'admin' };
}
