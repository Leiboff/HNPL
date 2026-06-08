import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import LogoutButton from '@/app/dashboard/LogoutButton';
import BillsBlock from './BillsBlock';
import { PlanSummary, formatRand } from './billHelpers';

// ─── Stat cards ───────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  valueClass = 'text-gray-900',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  );
}

function MoneyStatCard({
  label,
  value,
  theme,
}: {
  label: string;
  value: string;
  theme: 'green' | 'blue';
}) {
  const t = {
    green: { card: 'bg-green-50 border-green-200', label: 'text-green-700', value: 'text-green-900' },
    blue:  { card: 'bg-blue-50 border-blue-200',   label: 'text-blue-700',  value: 'text-blue-900'  },
  }[theme];
  return (
    <div className={`rounded-2xl border shadow-sm p-5 ${t.card}`}>
      <p className={`text-xs font-medium uppercase tracking-wide ${t.label}`}>{label}</p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${t.value}`}>{value}</p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

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
  const practiceName = practiceInfo?.name;
  const feePercent   = Number(practiceInfo?.fee_percent ?? 6);
  const practiceId   = membership.practice_id as string;
  const canManage    = (membership.can_manage_practice as boolean) ?? false;

  // All five queries in parallel
  const [
    { count: totalBills },
    { count: activePlans },
    { count: pendingAcceptance },
    { data: payoutsData },
    { data: rawPlans },
  ] = await Promise.all([
    supabase
      .from('plans')
      .select('*', { count: 'exact', head: true })
      .eq('practice_id', practiceId),
    supabase
      .from('plans')
      .select('*', { count: 'exact', head: true })
      .eq('practice_id', practiceId)
      .eq('status', 'active'),
    supabase
      .from('plans')
      .select('*', { count: 'exact', head: true })
      .eq('practice_id', practiceId)
      .eq('status', 'pending_acceptance'),
    supabase
      .from('payouts')
      .select('net_amount, status')
      .eq('practice_id', practiceId),
    supabase
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
      .limit(500),
  ]);

  const totalPaidOut = (payoutsData ?? []).reduce(
    (sum, p: any) => (p.status === 'paid'    ? sum + Number(p.net_amount) : sum), 0
  );
  const pendingPayout = (payoutsData ?? []).reduce(
    (sum, p: any) => (p.status === 'pending' ? sum + Number(p.net_amount) : sum), 0
  );

  const plans = (rawPlans ?? []) as PlanSummary[];

  const providerIds = [...new Set(
    plans.map(p => p.provider_id).filter((id): id is string => Boolean(id))
  )];
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
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <span className="text-lg font-semibold text-gray-900">BetterNow</span>
          <LogoutButton />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10 space-y-8">

        {/* Heading + CTA */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold text-gray-900">
              {practiceName ?? 'Practice Dashboard'}
            </h1>
            <p className="mt-1 text-gray-500">
              Welcome back, {profile?.first_name ?? user.email}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {canManage && (
              <a
                href="/practice/members"
                className="rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:border-gray-300 hover:bg-gray-50 transition-colors shadow-sm"
              >
                Manage team →
              </a>
            )}
            <a
              href="/practice/bills/new"
              className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
            >
              + Create a bill
            </a>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Total bills"          value={String(totalBills ?? 0)} />
          <StatCard label="Active plans"         value={String(activePlans ?? 0)}       valueClass="text-green-700" />
          <StatCard label="Awaiting acceptance"  value={String(pendingAcceptance ?? 0)} valueClass="text-amber-700" />
          <MoneyStatCard label="Total paid out to you" value={formatRand(totalPaidOut)}  theme="green" />
          <MoneyStatCard label="Pending payout"        value={formatRand(pendingPayout)} theme="blue"  />
        </div>

        {/* Bills table with filters + export */}
        <BillsBlock
          plans={plans}
          feePercent={feePercent}
          specialtyMap={specialtyMap}
          practiceName={practiceName ?? ''}
        />

      </main>
    </div>
  );
}
