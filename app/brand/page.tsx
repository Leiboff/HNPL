import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import BranchCreateLink from './BranchCreateLink';

// ─── Brand-admin dashboard (Phase 1 minimal) ───────────────────────────
//
// A user with at least one active practice_group_members row lands
// here. Shows every group they admin, with each group's branches and
// a "create branch" link.

type GroupRow  = { id: string; name: string; status: string };
type BranchRow = {
  id: string; name: string; status: string;
  city: string | null; suburb: string | null;
  group_id: string;
};

export default async function BrandDashboardPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // RLS: brand_admin_select_own_group covers this query.
  const { data: memberships } = await supabase
    .from('practice_group_members')
    .select('group_id, role, active')
    .eq('user_id', user.id)
    .eq('active', true);

  if (!memberships || memberships.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10">
        <h1 className="text-2xl font-semibold" style={{ color: '#13294B' }}>Brand admin</h1>
        <p className="mt-3 text-sm text-gray-600">
          You don&apos;t have brand-admin access to any group yet. Please contact BetterNow support.
        </p>
      </div>
    );
  }

  const groupIds = memberships.map((m) => m.group_id as string);

  const { data: rawGroups } = await supabase
    .from('practice_groups')
    .select('id, name, status')
    .in('id', groupIds);
  const groups = (rawGroups ?? []) as GroupRow[];

  const { data: rawBranches } = await supabase
    .from('practices')
    .select('id, name, status, city, suburb, group_id')
    .in('group_id', groupIds)
    .order('name');
  const branches = (rawBranches ?? []) as BranchRow[];

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold" style={{ color: '#13294B' }}>Brand admin</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage your group&apos;s branches. New branches go pending — BetterNow approves them before they can trade.
        </p>
      </header>

      {groups.map((g) => {
        const groupBranches = branches.filter((b) => b.group_id === g.id);
        return (
          <section key={g.id} className="space-y-3">
            <header className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900">{g.name}</h2>
              <BranchCreateLink groupId={g.id} />
            </header>

            {groupBranches.length === 0 ? (
              <p className="text-sm text-gray-500">No branches yet. Tap &ldquo;Add branch&rdquo; above.</p>
            ) : (
              <div className="space-y-2">
                {groupBranches.map((b) => (
                  <Link
                    key={b.id}
                    href={`/practice?practice_id=${b.id}`}
                    className="block rounded-xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 hover:bg-gray-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate">{b.name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{[b.suburb, b.city].filter(Boolean).join(', ') || '—'}</p>
                      </div>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        b.status === 'approved'  ? 'bg-green-100 text-green-700' :
                        b.status === 'pending'   ? 'bg-amber-100 text-amber-700' :
                        b.status === 'suspended' ? 'bg-red-100 text-red-700' :
                                                   'bg-gray-100 text-gray-500'
                      }`}>
                        {b.status}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
