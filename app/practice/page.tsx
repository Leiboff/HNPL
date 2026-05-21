import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import LogoutButton from '@/app/dashboard/LogoutButton';
import { calculateFee } from '@/lib/finance';

// ─── Types ────────────────────────────────────────────────────────────────────

type PatientRef = { first_name: string; last_name: string };
type PayoutRef  = { net_amount: number; status: string };

type PlanSummary = {
  id: string;
  total_amount: number;
  status: string;
  created_at: string;
  profiles: PatientRef | PatientRef[] | null;
  payouts:  PayoutRef  | PayoutRef[]  | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRand(amount: number): string {
  const [integer, decimal] = amount.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;

function formatDate(isoStr: string): string {
  const d = new Date(isoStr);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function patientDisplay(plan: PlanSummary): string {
  const p = Array.isArray(plan.profiles) ? plan.profiles[0] : plan.profiles;
  if (!p) return '—';
  return `${p.first_name} ${p.last_name.charAt(0).toUpperCase()}.`;
}

function getPayout(plan: PlanSummary): PayoutRef | null {
  if (!plan.payouts) return null;
  return Array.isArray(plan.payouts) ? (plan.payouts[0] ?? null) : plan.payouts;
}

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

// ─── Status badges ────────────────────────────────────────────────────────────

// Doctor-facing status labels — defaults/active/completed all mean "doctor was paid"
function doctorStatus(status: string): { label: string; cls: string } {
  switch (status) {
    case 'pending_acceptance': return { label: 'Awaiting patient', cls: 'bg-amber-100 text-amber-800' };
    case 'active':             return { label: 'Accepted',         cls: 'bg-green-100 text-green-700' };
    case 'completed':          return { label: 'Accepted',         cls: 'bg-green-100 text-green-700' };
    case 'defaulted':          return { label: 'Accepted',         cls: 'bg-green-100 text-green-700' };
    case 'declined':           return { label: 'Declined',         cls: 'bg-red-100 text-red-700'    };
    case 'cancelled':          return { label: 'Cancelled',        cls: 'bg-gray-100 text-gray-400'  };
    default:                   return { label: status,             cls: 'bg-gray-100 text-gray-600'  };
  }
}

function PlanStatusBadge({ status }: { status: string }) {
  const cfg = doctorStatus(status);
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
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
    .select('practice_id, practices(name, fee_percent)')
    .eq('user_id', user.id)
    .eq('active', true)
    .single();

  if (!membership) redirect('/practice/setup');

  const practiceInfo = membership.practices as unknown as { name: string; fee_percent: number } | null;
  const practiceName = practiceInfo?.name;
  const feePercent   = Number(practiceInfo?.fee_percent ?? 6);
  const practiceId   = membership.practice_id as string;

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
        id, total_amount, status, created_at,
        profiles(first_name, last_name),
        payouts(net_amount, status)
      `)
      .eq('practice_id', practiceId)
      .order('created_at', { ascending: false })
      .limit(25),
  ]);

  const totalPaidOut = (payoutsData ?? []).reduce(
    (sum, p: any) => (p.status === 'paid'    ? sum + Number(p.net_amount) : sum), 0
  );
  const pendingPayout = (payoutsData ?? []).reduce(
    (sum, p: any) => (p.status === 'pending' ? sum + Number(p.net_amount) : sum), 0
  );

  const plans = (rawPlans ?? []) as PlanSummary[];

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <span className="text-lg font-semibold text-gray-900">HNPL</span>
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
          <a
            href="/practice/bills/new"
            className="shrink-0 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
          >
            + Create a bill
          </a>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Total bills"          value={String(totalBills ?? 0)} />
          <StatCard label="Active plans"         value={String(activePlans ?? 0)}       valueClass="text-green-700" />
          <StatCard label="Awaiting acceptance"  value={String(pendingAcceptance ?? 0)} valueClass="text-amber-700" />
          <MoneyStatCard label="Total paid out to you" value={formatRand(totalPaidOut)}  theme="green" />
          <MoneyStatCard label="Pending payout"        value={formatRand(pendingPayout)} theme="blue"  />
        </div>

        {/* Recent plans */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Recent bills</h2>
            {plans.length > 0 && (
              <a
                href="/practice/bills/new"
                className="text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                + New bill
              </a>
            )}
          </div>

          {plans.length === 0 ? (
            <div className="py-20 text-center">
              <p className="font-medium text-gray-500">No bills yet</p>
              <p className="mt-1 text-sm text-gray-400">
                Create your first bill to start accepting patients.
              </p>
              <a
                href="/practice/bills/new"
                className="mt-5 inline-block rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
              >
                Create a bill
              </a>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left bg-gray-50">
                    <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Patient</th>
                    <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Bill</th>
                    <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Fee</th>
                    <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Net payout</th>
                    <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                    <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Payout status</th>
                    <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {plans.map((plan) => {
                    const payout = getPayout(plan);
                    const isPending = plan.status === 'pending_acceptance';
                    const { fee, net } = calculateFee(Number(plan.total_amount), feePercent);
                    return (
                      <tr key={plan.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4 font-medium text-gray-900 whitespace-nowrap">
                          {patientDisplay(plan)}
                        </td>
                        <td className="px-6 py-4 text-gray-700 whitespace-nowrap tabular-nums">
                          {formatRand(Number(plan.total_amount))}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap tabular-nums">
                          <span className={isPending ? 'text-gray-400' : 'text-gray-700'}>
                            −{formatRand(fee)}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap tabular-nums">
                          <span className={`font-medium ${isPending ? 'text-gray-400' : 'text-gray-900'}`}>
                            {formatRand(net)}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <PlanStatusBadge status={plan.status} />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {isPending ? (
                            <span className="text-xs text-gray-400">Not yet accepted</span>
                          ) : payout ? (
                            <span className={`text-xs font-medium capitalize ${
                              payout.status === 'paid'       ? 'text-green-700' :
                              payout.status === 'processing' ? 'text-blue-700'  :
                              payout.status === 'failed'     ? 'text-red-600'   :
                              'text-amber-700'
                            }`}>
                              {payout.status === 'paid' ? 'Paid' : 'Pending'}
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-gray-500 whitespace-nowrap">
                          {formatDate(plan.created_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}
