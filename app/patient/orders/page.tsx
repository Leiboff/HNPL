import { cache, Suspense } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { declinePlan } from '../actions';
import { isPatientFrozen } from '@/lib/patient/freeze';
import DefaultFreezeBanner from '../DefaultFreezeBanner';
import PatientScreen from '../PatientScreen';
import OrdersView from './OrdersView';
import { summariseOutstanding } from '@/lib/patient/outstanding';
import { planBucket } from '@/lib/patient/planBucket';
import { formatRand, todaySAST } from '../_format';
import { getRequestUser } from '@/lib/auth/requestUser';
import { NavyLine, PatientListBody } from '@/components/loading/PatientShellShape';

// ─── Types (shared with OrdersView via props) ─────────────────────────────────

export type PaymentRow = {
  id: string;
  instalment_number: number;
  amount: number;
  due_date: string;
  status: string;
  collected_at: string | null;
  dunning_fees_cents: number | null;
  next_attempt_date: string | null;
  /** 'instalment' (default) or 'settlement'. Settlement rows are
      filtered out of the per-plan list before render — they live in
      the audit timeline but are not instalments. */
  kind: string;
};

export type PlanRow = {
  id: string;
  invoice_number: string | null;
  practice_reference: string | null;
  total_amount: number;
  plan_type: number | null;
  status: string;
  created_at: string;
  practice_id: string;
  // Null until the first instalment CIT captures the card. A
  // pending_first_payment plan with this NULL is an abandoned first
  // charge — resumable (see OrdersView / the confirm page).
  peach_registration_id: string | null;
  practice: { name: string } | { name: string }[] | null;
  payments: PaymentRow[];
};

// ─── Page — v4 "Plans" ──────────────────────────────────────────────────────
//
// "Plans" itself is a static title — it renders immediately. Everything
// else on this screen (the outstanding/overdue summary in the header AND
// the plan list below it) reads the same `plans` query, so both stream in
// together off ONE shared, request-memoised fetch (loadOrdersData) rather
// than each re-querying. That still lets the real title (and the sheet's
// shape) paint before the numbers are ready, instead of the whole screen
// waiting on the slowest thing before ANY of it appears.

const loadOrdersData = cache(async (user: { id: string }) => {
  const supabase = await createClient();

  const { data: rawPlans } = await supabase
    .from('plans')
    .select(`
      id, invoice_number, practice_reference,
      total_amount, plan_type, status, created_at,
      practice_id, peach_registration_id,
      practice:practices(name),
      payments(id, instalment_number, amount, due_date, status, collected_at, dunning_fees_cents, next_attempt_date, kind)
    `)
    .eq('patient_id', user.id)
    .order('created_at', { ascending: false });

  const plans = ((rawPlans ?? []) as unknown as PlanRow[]).map((p) => ({
    ...p,
    // Strip settlement rows out of the per-plan schedule. Settlement
    // rows (kind='settlement', instalment_number=0) are audit-only and
    // would otherwise render as a phantom "Instalment 0" and inflate the
    // progress + outstanding sums. The audit trail lives in plan_events.
    payments: [...(p.payments ?? [])]
      .filter((pmt) => pmt.kind !== 'settlement')
      .sort((a, b) => a.instalment_number - b.instalment_number),
  }));

  // Default-freeze rollup (authoritative single source of truth).
  const isFrozen = await isPatientFrozen(supabase, user.id);

  // Bucketing is single-sourced in planBucket() so declined bills can't be
  // classified as "finished" here while the detail screen treats them
  // differently. declined gets its own bucket (no plan, no money taken).
  const pendingPlans  = plans.filter((p) => planBucket(p.status) === 'pending');
  const currentPlans  = plans.filter((p) => planBucket(p.status) === 'active');
  const finishedPlans = plans.filter((p) => planBucket(p.status) === 'finished');
  const declinedPlans = plans.filter((p) => planBucket(p.status) === 'declined');

  const hasInProgress = plans.some(
    (p) => p.status === 'pending_first_payment' || p.status === 'active',
  );
  const hasCompleted   = plans.some((p) => p.status === 'completed');
  const patientBlocked = hasInProgress && !hasCompleted;

  // ── Header summary: total outstanding + overdue count ─────────────
  // "Overdue" is derived (due date vs today), never read from the stored
  // status — otherwise a past-due `scheduled` row would go uncounted and
  // the header would claim "nothing overdue" while the schedule shows it.
  const today = todaySAST();
  // Shared source of truth — the home hero reads the SAME helper so the two
  // surfaces can never disagree on the total or the overdue count.
  const { outstandingCents, overdueCount } = summariseOutstanding(
    currentPlans.flatMap((p) => p.payments),
    today,
  );
  const summary =
    currentPlans.length === 0 && pendingPlans.length === 0
      ? 'Nothing outstanding'
      : `${formatRand(outstandingCents / 100)} outstanding · ${overdueCount > 0 ? `${overdueCount} overdue` : 'nothing overdue'}`;

  return { isFrozen, pendingPlans, currentPlans, finishedPlans, declinedPlans, patientBlocked, today, summary };
});

async function OrdersSummaryLine({ user }: { user: { id: string } }) {
  const { summary } = await loadOrdersData(user);
  return <p className="mt-1.5 text-[13.5px] tabular-nums" style={{ color: 'rgba(255,255,255,.62)' }}>{summary}</p>;
}

async function OrdersBody({ user }: { user: { id: string } }) {
  const { isFrozen, pendingPlans, currentPlans, finishedPlans, declinedPlans, patientBlocked, today } = await loadOrdersData(user);
  return (
    <div className="flex flex-col gap-[14px]">
      <DefaultFreezeBanner frozen={isFrozen} />
      <OrdersView
        pendingPlans={pendingPlans}
        currentPlans={currentPlans}
        finishedPlans={finishedPlans}
        declinedPlans={declinedPlans}
        declinePlan={declinePlan}
        patientBlocked={patientBlocked}
        today={today}
      />
    </div>
  );
}

export default async function OrdersPage() {
  const user = await getRequestUser();
  if (!user) redirect('/login');

  const header = (
    <>
      <p className="text-[24px] font-semibold text-white" style={{ letterSpacing: '-.025em' }}>Plans</p>
      <Suspense fallback={<NavyLine w="w-40" h="h-3" className="mt-1.5" />}>
        <OrdersSummaryLine user={user} />
      </Suspense>
    </>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <Suspense fallback={<PatientListBody label="Loading your plans" />}>
        <OrdersBody user={user} />
      </Suspense>
    </PatientScreen>
  );
}
