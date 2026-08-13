import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { updateOwnGroup } from '@/app/brand/actions';
import GroupEditForm from './GroupEditForm';
import BrandShell from '../BrandShell';

// ─── Brand-admin: edit own group — the Settings tab ────────────────────
//
// Edit the brand's display details — name and logo URL. Group-level
// banking is platform-admin-only (see app/admin/groups/[id]/page.tsx)
// and stays out of brand-admin reach to prevent payout redirects.
//
// It is the nav's Settings destination now, so it renders inside
// ../BrandShell like the other tabs. The hand-written "← Back to my
// practices" link is gone: the nav is the way in and the way out, and a
// one-off back-link beside a nav that already offers Overview is two
// answers to the same question. This is not a new surface — the nav
// points at the page that was already here (see ../brandNavLinks).

export const dynamic = 'force-dynamic';

export default async function BrandGroupSettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: rawMemberships } = await supabase
    .from('practice_group_members')
    .select('group_id')
    .eq('user_id', user.id)
    .eq('active', true);
  const memberships = (rawMemberships ?? []) as Array<{ group_id: string }>;
  if (memberships.length === 0) redirect('/practice');

  // For now, the form scopes to the FIRST brand the user admins. A
  // user with multiple brand_admin rows is a rare support case; if
  // it becomes common we'll add a brand picker.
  const groupId = memberships[0].group_id;

  // brand_admin_select_own_group (0061) lets the session client read
  // the group row directly.
  const { data: group } = await supabase
    .from('practice_groups')
    .select('id, name, logo_url')
    .eq('id', groupId)
    .maybeSingle();
  if (!group) redirect('/brand');

  return (
    <BrandShell brandName={(group.name as string) ?? null} brandCount={1}>
      <div className="max-w-xl space-y-6">
        <header>
          <h2 className="text-lg font-semibold" style={{ color: '#13294B' }}>Brand settings</h2>
          <p className="text-sm text-gray-500 mt-1">
            The name and logo your patients see across your practices.
          </p>
        </header>

        <GroupEditForm
          groupId={group.id as string}
          initialName={(group.name as string) ?? ''}
          initialLogoUrl={(group.logo_url as string | null) ?? null}
          saveAction={updateOwnGroup}
        />
      </div>
    </BrandShell>
  );
}
