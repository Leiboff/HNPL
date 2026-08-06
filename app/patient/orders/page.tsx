import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { declinePlan } from '../actions';
import { isPatientFrozen } from '@/lib/patient/freeze';
import DefaultFreezeBanner from '../DefaultFreezeBanner';
import PatientScreen from '../PatientScreen';
import OrdersView from './OrdersView';
import { deriveInstalmentStatus } from '@/lib/patient/instalmentStatus';
import { formatRand, todaySAST } from '../_format';

// ─── Status buckets ───────────────────────────────────────────────────────────

const PENDING_STATUSES  = new Set(['pending_acceptance', 'pending_first_payment']);
const CURRENT_STATUSES  = new Set(['active']);
const HISTORIC_STATUSES = new Set(['completed', 'declined', 'cancelled', 'defaulted']);

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

export type ProviderRef = { first_name: string; last_name: string };

export type PlanRow = {
  id: string;
  invoice_number: string | null;
  practice_reference: string | null;
  total_amount: number;
  plan_type: number | null;
  status: string;
  created_at: string;
  provider_id: string | null;
  practice_id: string;
  // Null until the first instalment CIT captures the card. A
  // pending_first_payment plan with this NULL is an abandoned first
  // charge — resumable (see OrdersView / the confirm page).
  peach_registration_id: string | null;
  provider: ProviderRef | ProviderRef[] | null;
  practice: { name: string } | { name: string }[] | null;
  payments: PaymentRow[];
};

// ─── Page — v4 "Plans" ──────────────────────────────────────────────────────

export default async function OrdersPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: rawPlans } = await supabase
    .from('plans')
    .select(`
      id, invoice_number, practice_reference,
      total_amount, plan_type, status, created_at,
      provider_id, practice_id, peach_registration_id,
      provider:profiles!plans_provider_id_fkey(first_name, last_name),
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

  const pendingPlans  = plans.filter((p) => PENDING_STATUSES.has(p.status));
  const currentPlans  = plans.filter((p) => CURRENT_STATUSES.has(p.status));
  const historicPlans = plans.filter((p) => HISTORIC_STATUSES.has(p.status));

  const hasInProgress = plans.some(
    (p) => p.status === 'pending_first_payment' || p.status === 'active',
  );
  const hasCompleted   = plans.some((p) => p.status === 'completed');
  const patientBlocked = hasInProgress && !hasCompleted;

  // ── Header summary: total outstanding + overdue count ─────────────
  // "Overdue" is derived (due date vs today), never read from the stored
  // status — otherwise a past-due `scheduled` row would go uncounted and
  // the header would claim "nothing overdue" while the schedule shows it.
  const outstandingStatuses = new Set(['scheduled', 'processing', 'failed', 'defaulted']);
  const today = todaySAST();
  let outstandingCents = 0;
  let overdueCount = 0;
  for (const p of currentPlans) {
    for (const pmt of p.payments) {
      if (!outstandingStatuses.has(pmt.status)) continue;
      outstandingCents += Math.round(Number(pmt.amount) * 100) + Number(pmt.dunning_fees_cents ?? 0);
      if (deriveInstalmentStatus(pmt, today) === 'overdue') overdueCount += 1;
    }
  }
  const summary =
    currentPlans.length === 0 && pendingPlans.length === 0
      ? 'Nothing outstanding'
      : `${formatRand(outstandingCents / 100)} outstanding · ${overdueCount > 0 ? `${overdueCount} overdue` : 'nothing overdue'}`;

  const header = (
    <>
      <p className="text-[24px] font-semibold text-white" style={{ letterSpacing: '-.025em' }}>Plans</p>
      <p className="mt-1.5 text-[13.5px] tabular-nums" style={{ color: 'rgba(255,255,255,.62)' }}>{summary}</p>
    </>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[14px]">
        <DefaultFreezeBanner frozen={isFrozen} />
        <OrdersView
          pendingPlans={pendingPlans}
          currentPlans={currentPlans}
          historicPlans={historicPlans}
          declinePlan={declinePlan}
          patientBlocked={patientBlocked}
          today={today}
        />
      </div>
    </PatientScreen>
  );
}
