import { redirect, notFound } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import PracticeShell from '../PracticeShell';
import { resolvePracticeShellAuthority } from '../practiceShellAuthority';
import { resolvePracticeViewer } from '../practiceViewer';
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

  // ── Step 3: which practice, by what authority ─────────────────────────
  //
  // Shared with the dashboard (../practiceViewer): an active
  // practice_members row, or — for an explicit ?practiceId= the caller
  // holds no membership on — real brand-admin authority over that
  // practice's group. The brand path matters here because
  // /brand/branch/[practiceId] now pivots into the practice dashboard,
  // and "Team" is a persistent nav link from there: without it a
  // brand-admin with no practice_members row on the branch would click
  // Team and be bounced straight back to the dashboard.
  //
  // isManager comes from canManagePractice, which the resolver reports as
  // FALSE on the brand path. So a brand-admin-only viewer reads the
  // roster and gets no member-editing UI — matching the server, where
  // app/practice/members/actions.ts guardManager() is
  // can_manage_practice-only with no brand path. No rights are widened
  // here; the read is simply no longer refused.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const viewer = await resolvePracticeViewer(supabase, svc, user.id, params.practiceId);
  if (viewer.kind === 'setup')  redirect('/practice');
  if (viewer.kind === 'denied') notFound();

  const { practiceId, canManagePractice, viaBrandAdmin } = viewer.scope;
  const isManager    = canManagePractice;
  const practiceName = viewer.scope.practiceName || 'Practice';

  // ── Nav-shell authority — shared resolver, see ../practiceShellAuthority.
  const { isBrandAdmin, canManageTill, brandPracticeCount } =
    await resolvePracticeShellAuthority(
      supabase, user.id, practiceId, isManager,
    );

  // ── Fetch all members (active + inactive) with profile join ───────────────
  // Service-role only on the brand path, for the documented reason: the
  // profiles join is not reachable for a brand-admin-only caller (0061
  // widened practice_members but deliberately not profiles).
  const reader = viaBrandAdmin ? svc : supabase;
  const { data: rawMembers } = await reader
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
      canManageTill={canManageTill}
      brandPracticeCount={brandPracticeCount}
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
