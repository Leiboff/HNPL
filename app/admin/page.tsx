import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import StatCard from './_components/StatCard';
import { formatRand, timeAgo } from './_lib/format';
import { classifyCronHealth, type CronRunRow } from './_lib/cronHealth';
import { budgetPressure } from '@/lib/risk/notify';

// ─── /admin (dashboard) ─────────────────────────────────────────────────────
//
// Exception-led: the page LEADS with what needs attention (or "All
// clear" when nothing does), with cron health as a sibling signal,
// then the steady-state inventory metrics below. Quiet when healthy,
// loud when something needs the operator.
//
// "At risk" customer / practice counts here are approximations of the
// shared standing classifier — we use the cheap proxy "any payments
// row in failed / retried / written_off" rather than running the full
// reliability calc per entity (which would be N+1 expensive on the
// dashboard). The detail pages use the proper classifier; this surface
// just needs the operator to know "X entities to investigate".

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

  const todayStr      = new Date().toISOString().slice(0, 10);
  const monthStartStr = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                          .toISOString().slice(0, 10);

  // ── Steady-state metrics ─────────────────────────────────────────────
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
    { data: atRiskPaymentRows },
    { count: openRiskReviewsCount },
    { data: engagedKillSwitchRows },
    { data: heldPracticeRows },
    { data: riskBudgetRows },
  ] = await Promise.all([
    supabase.from('practices').select('*',     { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('practices').select('*',     { count: 'exact', head: true }),
    supabase.from('practices').select('*',     { count: 'exact', head: true }).eq('status', 'approved'),
    supabase.from('practices').select('*',     { count: 'exact', head: true }).eq('status', 'suspended'),
    supabase.from('profiles').select('*',      { count: 'exact', head: true }).eq('role', 'patient'),
    supabase.from('plans').select('*',         { count: 'exact', head: true }).eq('status', 'active'),
    // All payment aggregations filter kind='instalment' so settlement
    // rows (kind='settlement', created by claim_plan_for_settlement in
    // 0058) don't double-count: a settle-entire-bill that collects 3
    // instalments produces 4 'collected' rows (3 instalments + the
    // settlement row whose amount is the sum). Counting both would
    // inflate "Collected this month" by exactly the sum of the
    // covered instalments. Same hazard on at-risk (failed settlement +
    // its reverted covered rows). The collections-detail table stays
    // unfiltered so admins can still see settlement rows for audit.
    supabase.from('payments').select('amount').eq('kind', 'instalment').eq('status', 'scheduled').eq('due_date', todayStr),
    supabase.from('payments').select('amount').eq('kind', 'instalment').eq('status', 'scheduled').lt('due_date', todayStr),
    supabase.from('payouts').select('net_amount').eq('status', 'pending'),
    supabase.from('payments').select('amount').eq('kind', 'instalment').eq('status', 'collected').gte('collected_at', monthStartStr),
    supabase.from('cron_runs').select('started_at, finished_at, summary')
      .eq('job_name', 'collect-instalments').order('started_at', { ascending: false }).limit(1).maybeSingle(),
    // At-risk proxy: payments currently in failed / retried (in-flight
    // trouble), defaulted (dunning terminal — debt owed, patient frozen)
    // or written_off (confirmed loss). The patient_id and plan_id fields
    // let us count distinct entities downstream.
    supabase.from('payments')
      .select('patient_id, plan_id, amount, status')
      .eq('kind', 'instalment')
      .in('status', ['failed', 'retried', 'defaulted', 'written_off']),
    // ── The aggregate fraud controls (0142/0143) ──────────────────────
    //
    // Four reads, all cheap, all counting or filtering an indexed column.
    // They are here rather than only on /admin/risk for the reason this
    // page exists: an operator opens the dashboard, and a control whose
    // output lives exclusively on a page nobody has a habit of visiting is
    // a control with an email and nothing else behind it.
    //
    // Read through the SESSION client like everything else here, so 0142's
    // is_platform_admin() policies do the gating and a demoted account
    // cannot see the queue.
    supabase.from('risk_reviews').select('*', { count: 'exact', head: true })
      .in('state', ['open', 'in_review']),
    supabase.from('risk_kill_switches').select('name').eq('engaged', true),
    // A practice held by the nightly circuit breaker. Unexpired blocks
    // only — a lapsed hold enforces nothing and reporting it would send
    // somebody to look at a practice that is trading normally.
    supabase.from('risk_blocks').select('token, action, reason, expires_at')
      .eq('dimension', 'practice')
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`),
    supabase.from('risk_budget_usage').select('budget, consumed')
      .eq('usage_day', todayStr),
  ]);

  const dueToday    = (dueTodayRows           ?? []) as Array<{ amount: number }>;
  const overdue     = (overdueRows            ?? []) as Array<{ amount: number }>;
  const pendingPay  = (pendingPayoutRows      ?? []) as Array<{ net_amount: number }>;
  const collectedMo = (collectedThisMonthRows ?? []) as Array<{ amount: number }>;
  const atRiskRows  = (atRiskPaymentRows      ?? []) as Array<{ patient_id: string | null; plan_id: string; amount: number; status: string }>;

  const dueTodayTotal     = dueToday.reduce((s, p) => s + Number(p.amount),     0);
  const overdueTotal      = overdue.reduce((s, p) => s + Number(p.amount),     0);
  const pendingPayoutTot  = pendingPay.reduce((s, p) => s + Number(p.net_amount), 0);
  const collectedMonthTot = collectedMo.reduce((s, p) => s + Number(p.amount),    0);

  // Resolve the at-risk plan_ids to their practice_ids — one extra
  // query, only when there are at-risk rows worth resolving.
  const atRiskPatientIds = new Set<string>();
  const atRiskPlanIds    = new Set<string>();
  let   atRiskTotal      = 0;
  for (const r of atRiskRows) {
    if (r.patient_id) atRiskPatientIds.add(r.patient_id);
    atRiskPlanIds.add(r.plan_id);
    // Only the "still outstanding" rows contribute to the at-risk amount.
    // written_off has already eaten the loss — it's not outstanding.
    if (r.status !== 'written_off') atRiskTotal += Number(r.amount);
  }

  let atRiskPracticeIdsCount = 0;
  if (atRiskPlanIds.size > 0) {
    const { data: planRows } = await supabase
      .from('plans')
      .select('practice_id')
      .in('id', [...atRiskPlanIds]);
    const practiceIds = new Set<string>();
    for (const row of (planRows ?? []) as Array<{ practice_id: string }>) {
      practiceIds.add(row.practice_id);
    }
    atRiskPracticeIdsCount = practiceIds.size;
  }

  const cronHealth   = classifyCronHealth(lastCronRunRow as CronRunRow | null);
  const cronAttention = cronHealth.state !== 'green';

  // ── Risk controls ────────────────────────────────────────────────────
  const openRiskReviews = openRiskReviewsCount ?? 0;
  const engagedSwitches = ((engagedKillSwitchRows ?? []) as Array<{ name: string }>)
    .map((r) => r.name);
  const heldPractices   = (heldPracticeRows ?? []) as Array<{ token: string; action: string }>;
  const riskBudgets     = (riskBudgetRows ?? []) as Array<{ budget: string; consumed: number | string }>;
  const pressuredBudgets = budgetPressure(riskBudgets);

  // Build the attention list — each item declares its own copy + link.
  // Empty list = the all-clear state below.
  type AttentionItem = {
    key:     string;
    tone:    'alert' | 'warn';
    label:   string;
    detail?: string;
    href:    string;
  };
  const attention: AttentionItem[] = [];

  // ── Risk first, and unconditionally at the top ───────────────────────
  //
  // An engaged kill switch means customers are being refused RIGHT NOW,
  // platform-wide. It outranks every other item on this page — an operator
  // reading "3 practices awaiting approval" above "new credit is switched
  // off" has been told the wrong thing first.
  if (engagedSwitches.length > 0) {
    attention.push({
      key:    'risk-kill-switches',
      tone:   'alert',
      label:  `${engagedSwitches.length === 1 ? 'A kill switch is' : `${engagedSwitches.length} kill switches are`} engaged · ${engagedSwitches.join(', ').replace(/_/g, ' ')}`,
      detail: 'Customers on these paths are being refused. Release when the incident is over.',
      href:   '/admin/risk',
    });
  }

  // Exhausted before merely-pressured, because the first is refusing
  // customers and the second is only going to.
  const exhausted = pressuredBudgets.filter((b) => b.fraction >= 1);
  const nearing   = pressuredBudgets.filter((b) => b.fraction < 1);

  if (exhausted.length > 0) {
    attention.push({
      key:    'risk-budgets-exhausted',
      tone:   'alert',
      label:  `${exhausted.length} daily budget${exhausted.length === 1 ? '' : 's'} exhausted · ${exhausted.map((b) => b.budget.replace(/_/g, ' ')).join(', ')}`,
      detail: 'Requests against these are being refused until midnight UTC. Raise the ceiling or find out why.',
      href:   '/admin/risk',
    });
  }

  if (nearing.length > 0) {
    attention.push({
      key:    'risk-budgets-nearing',
      tone:   'warn',
      label:  `${nearing.length} daily budget${nearing.length === 1 ? '' : 's'} above 80% · ${nearing.map((b) => `${b.budget.replace(/_/g, ' ')} ${Math.round(b.fraction * 100)}%`).join(', ')}`,
      detail: 'Not yet refusing anything. Worth knowing before it does.',
      href:   '/admin/risk',
    });
  }

  if (openRiskReviews > 0) {
    attention.push({
      key:    'risk-reviews',
      tone:   'alert',
      label:  `${openRiskReviews} held for risk review`,
      detail: 'Customers or practices the fraud controls stopped. Each one is waiting on a human decision.',
      href:   '/admin/risk',
    });
  }

  if (heldPractices.length > 0) {
    const denied = heldPractices.filter((p) => p.action === 'deny').length;
    attention.push({
      key:    'risk-practices-held',
      tone:   'alert',
      label:  `${heldPractices.length} practice${heldPractices.length === 1 ? '' : 's'} held by the circuit breaker`,
      detail: denied > 0
        ? `${denied} with payouts stopped. Exposure, payout volume, new-customer inflow or first-payment rate breached.`
        : 'Parked for review — one threshold breached, not yet two.',
      href:   '/admin/risk',
    });
  }

  if ((pendingPracticesCount ?? 0) > 0) {
    attention.push({
      key:    'pending-practices',
      tone:   'warn',
      label:  `${pendingPracticesCount} practice${pendingPracticesCount === 1 ? '' : 's'} awaiting approval`,
      detail: 'Review identity, banking and HPCSA before approving.',
      href:   '/admin/practices?status=pending',
    });
  }

  if (overdue.length > 0) {
    attention.push({
      key:    'overdue',
      tone:   'alert',
      label:  `${overdue.length} overdue collection${overdue.length === 1 ? '' : 's'} · ${formatRand(overdueTotal)}`,
      detail: 'Cron should have picked these up. Check cron health if it persists.',
      href:   '/admin/collections?chip=overdue',
    });
  }

  if (atRiskPatientIds.size > 0) {
    attention.push({
      key:    'at-risk-customers',
      tone:   'alert',
      label:  `${atRiskPatientIds.size} customer${atRiskPatientIds.size === 1 ? '' : 's'} at risk · ${formatRand(atRiskTotal)}`,
      detail: 'Customers with failed / retried / written-off instalments.',
      href:   '/admin/customers?sort=outstanding-desc',
    });
  }

  if (atRiskPracticeIdsCount > 0) {
    attention.push({
      key:    'at-risk-practices',
      tone:   'alert',
      label:  `${atRiskPracticeIdsCount} practice book${atRiskPracticeIdsCount === 1 ? '' : 's'} at risk`,
      detail: 'Practices whose patients have failed or written-off instalments.',
      href:   '/admin/practices?status=approved',
    });
  }

  if (pendingPay.length > 0) {
    attention.push({
      key:    'payouts',
      tone:   'warn',
      label:  `${pendingPay.length} payout${pendingPay.length === 1 ? '' : 's'} owed · ${formatRand(pendingPayoutTot)}`,
      detail: 'Settle via Peach / banking, then mark paid.',
      href:   '/admin/payouts',
    });
  }

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 space-y-6 sm:space-y-8">

      {/* Heading */}
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Dashboard</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Welcome, {profile?.first_name ?? user.email}
        </p>
      </div>

      {/* ── Cron health (engine alive signal — always shown) ──────────── */}
      <CronHealthCard health={cronHealth} />

      {/* ── Needs attention (loud when there's work, quiet when not) ─── */}
      <section
        className={`rounded-2xl border-2 p-5 ${
          attention.length === 0 && !cronAttention
            ? 'border-green-200 bg-green-50'
            : 'border-amber-200 bg-amber-50'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${
            attention.length === 0 && !cronAttention ? 'bg-green-500' : 'bg-amber-500'
          }`} aria-hidden />
          <h2 className="text-sm font-semibold text-gray-900">
            {attention.length === 0 && !cronAttention
              ? 'All clear — nothing needs attention'
              : `Needs attention · ${attention.length}`}
          </h2>
        </div>

        {attention.length === 0 ? (
          <p className="mt-2 text-sm text-gray-600">
            No pending practices, no overdue collections, no at-risk patients or practice books,
            no payouts owed.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {attention.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className={`flex items-start gap-3 rounded-xl border p-3 bg-white hover:shadow-sm transition-all ${
                    item.tone === 'alert' ? 'border-red-200' : 'border-amber-200'
                  }`}
                >
                  <span
                    className={`mt-1.5 inline-block w-2 h-2 rounded-full shrink-0 ${
                      item.tone === 'alert' ? 'bg-red-500' : 'bg-amber-500'
                    }`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium ${
                      item.tone === 'alert' ? 'text-red-900' : 'text-amber-900'
                    }`}>
                      {item.label}
                    </p>
                    {item.detail && (
                      <p className="mt-0.5 text-xs text-gray-600">{item.detail}</p>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 self-center shrink-0">→</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Steady-state metrics (background view) ────────────────────── */}
      <div className="space-y-6">
        <div className="border-t border-gray-200 pt-6">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Practices
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Total practices"
              value={String(totalPracticesCount ?? 0)}
              sublabel={`${approvedPracticesCount ?? 0} approved · ${suspendedPracticesCount ?? 0} suspended`}
              href="/admin/practices?status=approved"
            />
            <StatCard
              label="Awaiting approval"
              value={String(pendingPracticesCount ?? 0)}
              tone={(pendingPracticesCount ?? 0) > 0 ? 'warn' : 'default'}
              href="/admin/practices?status=pending"
            />
            <StatCard
              label="Total patients"
              value={String(totalPatientsCount ?? 0)}
              href="/admin/customers"
            />
            <StatCard
              label="Active plans"
              value={String(activePlansCount ?? 0)}
              tone="good"
            />
          </div>
        </div>

        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Collections
          </h2>
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
              sublabel={`${collectedMo.length} payment${collectedMo.length === 1 ? '' : 's'} · by collected_at`}
              tone="good"
              href="/admin/collections?chip=collected"
            />
          </div>
        </div>

        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Payouts
          </h2>
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
