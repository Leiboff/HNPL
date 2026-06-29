import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import {
  updateGroupBanking,
  grantBrandAdmin,
  revokeBrandAdmin,
} from '../actions';
import GroupBankingForm from './GroupBankingForm';
import GroupBranchManager from './GroupBranchManager';
import GroupBrandAdminManager from './GroupBrandAdminManager';

// ─── Platform-admin: practice-group detail ─────────────────────────────
//
// One screen with three management surfaces:
//   1. Central banking (the group's banking row that branches fall
//      back to when they have none of their own).
//   2. Branches — currently in the group, and standalone practices the
//      admin can pull into the group.
//   3. Brand admins — grant / revoke a user as brand-admin of this group.

type GroupRow = {
  id:                  string;
  name:                string;
  status:              string;
  bank_name:           string | null;
  bank_account_number: string | null;
  branch_code:         string | null;
  account_holder:      string | null;
  account_type:        string | null;
};

type BranchRow = {
  id:        string;
  name:      string;
  status:    string;
  city:      string | null;
  suburb:    string | null;
};

type GroupMemberRow = {
  user_id: string;
  role:    string;
  active:  boolean;
  profile: { first_name: string; last_name: string; email: string } | null;
};

export default async function AdminGroupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (profile?.role !== 'admin') redirect('/');

  const { data: group } = await supabase
    .from('practice_groups')
    .select('id, name, status, bank_name, bank_account_number, branch_code, account_holder, account_type')
    .eq('id', id)
    .maybeSingle();
  if (!group) notFound();

  const groupRow = group as GroupRow;

  // Practices in this brand. Post-0062 every practice belongs to a
  // brand — there are no orphan/standalone practices to "pull in"
  // anymore. Brand membership is set at signup or via brand-owner
  // self-service add-another-practice; admin only ever views it here.
  const { data: branches } = await supabase
    .from('practices')
    .select('id, name, status, city, suburb')
    .eq('group_id', id)
    .order('name');

  // Brand admins of this group
  const { data: rawAdmins } = await supabase
    .from('practice_group_members')
    .select(`
      user_id, role, active,
      profile:profiles!practice_group_members_user_id_fkey(first_name, last_name, email)
    `)
    .eq('group_id', id);

  const admins = ((rawAdmins ?? []) as unknown as GroupMemberRow[]).map((m) => ({
    ...m,
    profile: Array.isArray(m.profile) ? m.profile[0] ?? null : m.profile,
  }));

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-10 space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <Link href="/admin/groups" className="text-xs text-gray-500 hover:underline">← All groups</Link>
          <h1 className="text-2xl font-semibold" style={{ color: '#13294B' }}>{groupRow.name}</h1>
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          groupRow.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
        }`}>
          {groupRow.status}
        </span>
      </header>

      <section className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm p-5">
        <h2 className="text-sm font-semibold mb-3" style={{ color: '#13294B' }}>Central banking</h2>
        <p className="text-xs text-gray-500 mb-4">
          Branches with no own banking fall back to this row. Leave blank for per-branch billing.
        </p>
        <GroupBankingForm
          groupId={groupRow.id}
          initial={{
            bankName:          groupRow.bank_name,
            bankAccountNumber: groupRow.bank_account_number,
            branchCode:        groupRow.branch_code,
            accountHolder:     groupRow.account_holder,
            accountType:       (groupRow.account_type as 'current' | 'savings' | null) ?? null,
          }}
          saveAction={updateGroupBanking}
        />
      </section>

      <section className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm p-5">
        <h2 className="text-sm font-semibold mb-3" style={{ color: '#13294B' }}>Practices</h2>
        <p className="text-xs text-gray-500 mb-3">
          Practices that belong to this brand. New practices are added by the brand owner from their dashboard.
        </p>
        <GroupBranchManager
          branches={(branches ?? []) as BranchRow[]}
        />
      </section>

      <section className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm p-5">
        <h2 className="text-sm font-semibold mb-3" style={{ color: '#13294B' }}>Brand admins</h2>
        <p className="text-xs text-gray-500 mb-4">
          Grant a user brand-admin rights over this group. They can see and manage every branch but cannot approve branches (that stays on the platform-admin path).
        </p>
        <GroupBrandAdminManager
          groupId={groupRow.id}
          admins={admins}
          grantAction={grantBrandAdmin}
          revokeAction={revokeBrandAdmin}
        />
      </section>
    </div>
  );
}
