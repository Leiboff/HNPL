import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PracticeShell from './PracticeShell';
import PracticeDashboardClient from './PracticeDashboardClient';
import { PlanSummary } from './billHelpers';

export default async function PracticeDashboardPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_admin' && profile?.role !== 'practice_staff') {
    if (profile?.role === 'patient') redirect('/patient');
    else if (profile?.role === 'admin') redirect('/admin');
    else redirect('/login');
  }

  const { data: membership } = await supabase
    .from('practice_members')
    .select('practice_id, can_manage_practice, practices(name, fee_percent)')
    .eq('user_id', user.id)
    .eq('active', true)
    .single();

  if (!membership) redirect('/practice/setup');

  const practiceInfo = membership.practices as unknown as { name: string; fee_percent: number } | null;
  const practiceName = practiceInfo?.name ?? '';
  const feePercent   = Number(practiceInfo?.fee_percent ?? 6);
  const practiceId   = membership.practice_id as string;

  const { data: rawPlans } = await supabase
    .from('plans')
    .select(`
      id, total_amount, status, created_at, invoice_number, practice_reference,
      provider_id,
      patient:profiles!plans_patient_id_fkey(first_name, last_name),
      provider:profiles!plans_provider_id_fkey(first_name, last_name),
      payouts(net_amount, status)
    `)
    .eq('practice_id', practiceId)
    .order('created_at', { ascending: false })
    .limit(500);

  const plans = (rawPlans ?? []) as PlanSummary[];

  const providerIds = [...new Set(plans.map((p) => p.provider_id).filter((id): id is string => Boolean(id)))];
  const specialtyMap: Record<string, string> = {};
  if (providerIds.length > 0) {
    const { data: memberRows } = await supabase
      .from('practice_members')
      .select('user_id, specialty')
      .eq('practice_id', practiceId)
      .in('user_id', providerIds);
    for (const m of (memberRows ?? []) as { user_id: string; specialty: string | null }[]) {
      if (m.specialty) specialtyMap[m.user_id] = m.specialty;
    }
  }

  return (
    <PracticeShell practiceName={practiceName}>
      <main className="px-4 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-8">

        {/* Heading */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold truncate" style={{ color: '#13294B' }}>
              {practiceName || 'Dashboard'}
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Welcome back, {profile?.first_name ?? user.email}
            </p>
          </div>
          <a
            href="/practice/bills/new"
            className="shrink-0 rounded-lg px-4 py-2 sm:px-5 sm:py-2.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            + Create a bill
          </a>
        </div>

        {/* Dashboard: global filters + chart + bills */}
        <PracticeDashboardClient
          plans={plans}
          feePercent={feePercent}
          specialtyMap={specialtyMap}
          practiceName={practiceName}
        />

      </main>
    </PracticeShell>
  );
}
