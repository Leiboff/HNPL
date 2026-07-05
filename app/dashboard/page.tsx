import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';

// ─── Post-auth role dispatcher ─────────────────────────────────────────
//
// Every post-login / post-reset-password / post-signup-confirmation
// landing funnels here. This is the ONE place that decides
// role → destination.
//
// Practice-side users can ALSO be brand-admins of one or more brands
// (post-0062 the solo signup silently creates a brand). If they are,
// route to /brand — which has its own n=1 rule that self-redirects
// solo owners back to /practice. So:
//
//   patient                 → /patient
//   practice_admin/staff    → /brand   if they hold ANY active
//                             practice_group_members row (brand-admin)
//                           → /practice  otherwise (staff, non-owner)
//   practice_provider       → /provider
//   admin (platform)        → /admin
//
// Solo brand-admins never notice this hop — /brand redirects them
// straight to /practice. Multi-branch owners land on the group
// dashboard instead of an arbitrary practice page.

export default async function DashboardPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/dashboard' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name')
    .eq('id', user.id)
    .single();

  switch (profile?.role) {
    case 'patient':
      redirect('/patient');
    case 'practice_admin':
    case 'practice_staff': {
      // Brand-admin check — session client, RLS-scoped. Same query the
      // /brand page uses. Cheap (indexed lookup on user_id).
      const { data: brandMemberships } = await supabase
        .from('practice_group_members')
        .select('group_id')
        .eq('user_id', user.id)
        .eq('active', true)
        .limit(1);

      if (brandMemberships && brandMemberships.length > 0) {
        redirect('/brand');
      }
      redirect('/practice');
    }
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
