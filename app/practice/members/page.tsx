import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import LogoutButton from '@/app/dashboard/LogoutButton';
import MembersView from './MembersView';
import type { MemberRow } from './MembersView';

export default async function MembersPage() {
  const supabase = await createClient();

  // ── Step 1: auth ──────────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

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

  // ── Step 3: active membership ─────────────────────────────────────────────
  const { data: membership } = await supabase
    .from('practice_members')
    .select('practice_id, can_manage_practice, practices(name)')
    .eq('user_id', user.id)
    .eq('active', true)
    .single();

  if (!membership) redirect('/practice');

  const practiceId   = membership.practice_id as string;
  const isManager    = (membership.can_manage_practice as boolean) ?? false;
  const practiceInfo = membership.practices as unknown as { name: string } | null;
  const practiceName = practiceInfo?.name ?? 'Practice';

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
    <div className="min-h-screen bg-[#f7fbfb]">

      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-4xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
              <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
            </span>
            <span className="text-sm text-gray-400">— {practiceName}</span>
          </div>
          <LogoutButton />
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 pt-4">
        <a href="/practice" className="text-sm text-[#15A89E] hover:text-[#13294B] transition-colors">
          ← Back to dashboard
        </a>
      </div>

      <main className="mx-auto max-w-4xl px-6 py-8 pb-20">
        <MembersView
          members={members}
          currentUserId={user.id}
          isManager={isManager}
          practiceName={practiceName}
        />
      </main>

    </div>
  );
}
