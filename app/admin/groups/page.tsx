import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createGroup } from './actions';
import GroupCreateForm from './GroupCreateForm';

// ─── Platform-admin: practice-groups index ─────────────────────────────
//
// Phase 1 minimal: list every group + a "create new" form. Group detail
// (assign practices, banking, brand-admins) lives in [id]/page.tsx.

type GroupRow = {
  id:         string;
  name:       string;
  status:     string;
  created_at: string;
};

export default async function AdminGroupsPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (profile?.role !== 'admin') redirect('/');

  // RLS allows platform_admin to read all groups (policy
  // platform_admin_all_practice_groups in 0061).
  const { data: rawGroups } = await supabase
    .from('practice_groups')
    .select('id, name, status, created_at')
    .order('created_at', { ascending: false });

  const groups = (rawGroups ?? []) as GroupRow[];

  // Each group's branch + brand-admin counts for the list view.
  const groupIds = groups.map((g) => g.id);
  const branchCount = new Map<string, number>();
  const adminCount  = new Map<string, number>();

  if (groupIds.length > 0) {
    const { data: branches } = await supabase
      .from('practices')
      .select('id, group_id')
      .in('group_id', groupIds);
    for (const b of (branches ?? []) as Array<{ group_id: string }>) {
      branchCount.set(b.group_id, (branchCount.get(b.group_id) ?? 0) + 1);
    }
    const { data: brandAdmins } = await supabase
      .from('practice_group_members')
      .select('group_id')
      .in('group_id', groupIds)
      .eq('active', true);
    for (const m of (brandAdmins ?? []) as Array<{ group_id: string }>) {
      adminCount.set(m.group_id, (adminCount.get(m.group_id) ?? 0) + 1);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold" style={{ color: '#13294B' }}>Practice groups</h1>
        <p className="text-sm text-gray-500 mt-1">
          Brands grouping multiple branches. A practice with no group is a standalone practice.
        </p>
      </header>

      <section className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm p-5">
        <h2 className="text-sm font-semibold mb-3" style={{ color: '#13294B' }}>Create a new group</h2>
        <GroupCreateForm createAction={createGroup} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold" style={{ color: '#13294B' }}>Existing groups ({groups.length})</h2>
        {groups.length === 0 ? (
          <p className="text-sm text-gray-500">No groups yet.</p>
        ) : (
          <div className="space-y-2">
            {groups.map((g) => (
              <Link
                key={g.id}
                href={`/admin/groups/${g.id}`}
                className="block rounded-xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 hover:bg-gray-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{g.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {branchCount.get(g.id) ?? 0} branch{(branchCount.get(g.id) ?? 0) === 1 ? '' : 'es'} ·{' '}
                      {adminCount.get(g.id) ?? 0} brand admin{(adminCount.get(g.id) ?? 0) === 1 ? '' : 's'}
                    </p>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    g.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {g.status}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
