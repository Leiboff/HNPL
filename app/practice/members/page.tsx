import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import PracticeShell from '../PracticeShell';
import MembersView from './MembersView';
import type { MemberRow } from './MembersView';

type SearchParams = { practiceId?: string };

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  // ── Step 1: auth + email-confirmed gate ───────────────────────────────────
  const { user, supabase } = await requireConfirmedUser({ next: '/practice/members' });

  // ── Step 2: role ──────────────────────────────────────────────────────────
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_admin' && profile?.role !== 'practice_staff') {
    if (profile?.role === 'patient') redirect('/patient');
    else if (profile?.role === 'admin') redirect('/admin');
    else redirect('/login');
  }

  // ── Step 3: active membership — post-0062 a brand-admin has N≥2 rows.
  // Match /practice dashboard's pattern (order+limit, not .single()).
  const { data: rawMemberships } = await supabase
    .from('practice_members')
    .select('practice_id, can_manage_practice, created_at, practices(name)')
    .eq('user_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: true });

  const memberRowsRaw = (rawMemberships ?? []) as unknown as Array<{
    practice_id:         string;
    can_manage_practice: boolean | null;
    created_at:          string;
    practices:           { name: string } | { name: string }[] | null;
  }>;
  const memberRows = memberRowsRaw.map((m) => ({
    ...m,
    practices: Array.isArray(m.practices) ? (m.practices[0] ?? null) : m.practices,
  }));

  if (memberRows.length === 0) redirect('/practice');

  const requestedId = params.practiceId;
  const picked =
    (requestedId && memberRows.find((m) => m.practice_id === requestedId)) ||
    memberRows[0];

  const practiceId   = picked.practice_id;
  const isManager    = (picked.can_manage_practice as boolean) ?? false;
  const practiceInfo = picked.practices;
  const practiceName = practiceInfo?.name ?? 'Practice';

  // ── Brand-admin gate for the sidebar's "Practice details" link ────
  const { data: practiceGroupRow } = await supabase
    .from('practices')
    .select('group_id')
    .eq('id', practiceId)
    .maybeSingle();
  let isBrandAdmin = false;
  if (practiceGroupRow?.group_id) {
    const { data: brandMembership } = await supabase
      .from('practice_group_members')
      .select('user_id')
      .eq('group_id', practiceGroupRow.group_id)
      .eq('user_id',  user.id)
      .eq('active',   true)
      .maybeSingle();
    isBrandAdmin = !!brandMembership;
  }

  // ── Fetch all members (active + inactive) with profile join ───────────────
  const { data: rawMembers } = await supabase
    .from('practice_members')
    .select(`
      id, user_id, role, active,
      can_create_bills, can_manage_practice,
      specialty, hpcsa_number, payout_destination,
      personal_bank_name, personal_account_holder,
      personal_account_number, personal_branch_code, personal_account_type,
      profile:profiles!practice_members_user_id_fkey(first_name, last_name, email)
    `)
    .eq('practice_id', practiceId)
    .order('active', { ascending: false })
    .order('role',   { ascending: true  });

  const members = (rawMembers ?? []) as MemberRow[];

  return (
    <PracticeShell
      practiceName={practiceName}
      practiceId={practiceId}
      isBrandAdmin={isBrandAdmin}
      canManageTill={isManager || isBrandAdmin}
    >
      <main className="px-4 sm:px-6 py-6 sm:py-8 pb-20">
        <MembersView
          members={members}
          currentUserId={user.id}
          isManager={isManager}
          practiceName={practiceName}
        />
      </main>
    </PracticeShell>
  );
}
