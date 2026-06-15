import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import StatCard from './_components/StatCard';
import { formatRand, timeAgo } from './_lib/format';
import { classifyCronHealth, type CronRunRow } from './_lib/cronHealth';

// ─── /admin (dashboard) ─────────────────────────────────────────────────────
//
// At-a-glance metrics + alert signals only. No granular tables —
// every metric is a link into the page where you act on it.
//
// Pre-launch the numbers will be sparse / zero — that's correct,
// don't fabricate. The data model is live; once real practices sign
// up and patients accept plans, these populate.

export default async function AdminDashboardPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  const todayStr        = new Date().toISOString().slice(0, 10);
  const monthStartStr   = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                            .toISOString().slice(0, 10);

  // ── One round-trip per metric. Counts use head:true so PostgREST
  //    returns just the count (no row body), and money totals fetch the
  //    minimal `amount` / `net_amount` field set we sum locally.
  const [
    { count: pendingPracticesCount },
    { count: totalPracticesCount },
    { count: approvedPracticesCount },
    { count: suspendedPracticesCount },
    { count: totalPatientsCount },
    { count: activePlansCount },
    { data: dueTodayRows },
    { data: overdueRows },
    { data: pendingPayoutRows },
    { data: collectedThisMonthRows },
    { data: lastCronRunRow },
  ] = await Promise.all([
    supabase.from('practices').select('*',     { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('practices').select('*',     { count: 'exact', head: true }),
    supabase.from('practices').select('*',     { count: 'exact', head: true }).eq('status', 'approved'),
    supabase.from('practices').select('*',     { count: 'exact', head: true }).eq('status', 'suspended'),
    supabase.from('profiles').select('*',      { count: 'exact', head: true }).eq('role', 'patient'),
    supabase.from('plans').select('*',         { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('payments').select('amount').eq('status', 'scheduled').eq('due_date', todayStr),
    supabase.from('payments').select('amount').eq('status', 'scheduled').lt('due_date', todayStr),
    supabase.from('payouts').select('net_amount').eq('status', 'pending'),
    supabase.from('payments').select('amount').eq('status', 'collected').gte('collected_at', monthStartStr),
    supabase.from('cron_runs').select('started_at, finished_at, summary')
      .eq('job_name', 'collect-instalments').order('started_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const dueToday     = (dueTodayRows         ?? []) as Array<{ amount: number }>;
  const overdue      = (overdueRows          ?? []) as Array<{ amount: number }>;
  const pendingPay   = (pendingPayoutRows    ?? []) as Array<{ net_amount: number }>;
  const collectedMo  = (collectedThisMonthRows ?? []) as Array<{ amount: number }>;

  const dueTodayTotal     = dueToday.reduce((s, p) => s + Number(p.amount),     0);
  const overdueTotal      = overdue.reduce((s, p) => s + Number(p.amount),     0);
  const pendingPayoutTot  = pendingPay.reduce((s, p) => s + Number(p.net_amount), 0);
  const collectedMonthTot = collectedMo.reduce((s, p) => s + Number(p.amount),    0);

  const cronHealth = classifyCronHealth(lastCronRunRow as CronRunRow | null);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6 sm:space-y-8">

      {/* Heading */}
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Dashboard</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Welcome, {profile?.first_name ?? user.email}
        </p>
      </div>

      {/* ── Cron health (top — most important signal) ────────────────── */}
      <CronHealthCard health={cronHealth} />

      {/* ── Practices ────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Practices</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Awaiting approval"
            value={String(pendingPracticesCount ?? 0)}
            tone={(pendingPracticesCount ?? 0) > 0 ? 'warn' : 'default'}
            href="/admin/practices?status=pending"
          />
          <StatCard
            label="Total practices"
            value={String(totalPracticesCount ?? 0)}
            sublabel={`${approvedPracticesCount ?? 0} approved · ${suspendedPracticesCount ?? 0} suspended`}
            href="/admin/practices?status=approved"
          />
          <StatCard
            label="Total patients"
            value={String(totalPatientsCount ?? 0)}
          />
          <StatCard
            label="Active plans"
            value={String(activePlansCount ?? 0)}
            tone="good"
          />
        </div>
      </div>

      {/* ── Collections ──────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Collections</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <StatCard
            label="Due today"
            value={formatRand(dueTodayTotal)}
            sublabel={`${dueToday.length} installment${dueToday.length === 1 ? '' : 's'}`}
            href="/admin/collections?chip=upcoming"
          />
          <StatCard
            label="Overdue"
            value={formatRand(overdueTotal)}
            sublabel={`${overdue.length} installment${overdue.length === 1 ? '' : 's'}`}
            tone={overdue.length > 0 ? 'alert' : 'default'}
            href="/admin/collections?chip=overdue"
          />
          <StatCard
            label="Collected this month"
            value={formatRand(collectedMonthTot)}
            sublabel={`${collectedMo.length} payment${collectedMo.length === 1 ? '' : 's'}`}
            tone="good"
            href="/admin/collections?chip=collected"
          />
        </div>
      </div>

      {/* ── Payouts ──────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Payouts</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <StatCard
            label="Owed to practices"
            value={formatRand(pendingPayoutTot)}
            sublabel={`${pendingPay.length} payout${pendingPay.length === 1 ? '' : 's'} pending`}
            tone={pendingPay.length > 0 ? 'warn' : 'default'}
            href="/admin/payouts"
          />
        </div>
      </div>

    </div>
  );
}

// ─── Cron-health card ───────────────────────────────────────────────────────

function CronHealthCard({ health }: { health: ReturnType<typeof classifyCronHealth> }) {
  const STATE_CLS = {
    green: { wrap: 'border-green-200 bg-green-50', dot: 'bg-green-500',  text: 'text-green-900' },
    amber: { wrap: 'border-amber-300 bg-amber-50', dot: 'bg-amber-500',  text: 'text-amber-900' },
    red:   { wrap: 'border-red-300   bg-red-50',   dot: 'bg-red-500',    text: 'text-red-900'   },
  }[health.state];

  return (
    <Link
      href="/admin/collections/cron"
      data-testid="cron-health-card"
      className={`block rounded-2xl border-2 ${STATE_CLS.wrap} p-5 hover:shadow-sm transition-all`}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full ${STATE_CLS.dot}`} aria-hidden />
            <p className={`text-sm font-semibold ${STATE_CLS.text}`}>
              Collection engine — {health.label}
            </p>
          </div>
          <p className={`mt-1 text-xs ${STATE_CLS.text} opacity-80`}>{health.detail}</p>
          {health.lastRunStartedAt && (
            <p className="mt-1 text-xs text-gray-500">
              Last run {timeAgo(health.lastRunStartedAt)}
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-1 text-xs tabular-nums shrink-0">
          <Stat label="Eligible"    value={health.eligible} />
          <Stat label="Charged"     value={health.charged}   tone="good" />
          <Stat label="Claim-lost"  value={health.failed}   tone="muted" />
          <Stat label="Transport"   value={health.transportErrors} tone={health.transportErrors > 0 ? 'alert' : 'muted'} />
          <Stat label="Written off" value={health.writtenOff}      tone={health.writtenOff      > 0 ? 'alert' : 'muted'} />
        </div>
      </div>
    </Link>
  );
}

function Stat({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'good' | 'muted' | 'alert' }) {
  const cls = {
    default: 'text-gray-800',
    good:    'text-green-700',
    muted:   'text-gray-500',
    alert:   'text-red-700 font-semibold',
  }[tone];
  return (
    <div className="text-right sm:text-left">
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`text-sm font-semibold ${cls}`}>{value}</p>
    </div>
  );
}
