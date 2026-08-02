import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { declinePlan } from '../actions';
import { selfSettleInstalment, selfSettleEntirePlan } from './settle-actions';
import OrdersView from './OrdersView';

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

// ─── Page ─────────────────────────────────────────────────────────────────────

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
    // rows (kind='settlement', instalment_number=0) are audit-only —
    // they represent a "settle entire bill" charge and would otherwise
    // render as a phantom "Instalment 0", inflate computePlanProgress
    // totals, and double-count the outstanding sum used by the
    // Settle-entire-bill button. The audit trail lives in plan_events.
    payments: [...(p.payments ?? [])]
      .filter((pmt) => pmt.kind !== 'settlement')
      .sort((a, b) => a.instalment_number - b.instalment_number),
  }));

  const providerIds = [...new Set(
    plans.map(p => p.provider_id).filter((id): id is string => Boolean(id))
  )];
  const practiceIds = [...new Set(plans.map(p => p.practice_id).filter(Boolean))];
  const specialtyMap: Record<string, string> = {};
  if (providerIds.length > 0) {
    const { data: memberRows } = await supabase
      .from('practice_members')
      .select('user_id, practice_id, specialty')
      .in('user_id', providerIds)
      .in('practice_id', practiceIds);
    for (const m of (memberRows ?? []) as { user_id: string; practice_id: string; specialty: string | null }[]) {
      if (m.specialty) specialtyMap[`${m.user_id}:${m.practice_id}`] = m.specialty;
    }
  }

  const pendingPlans  = plans.filter((p) => PENDING_STATUSES.has(p.status));
  const currentPlans  = plans.filter((p) => CURRENT_STATUSES.has(p.status));
  const historicPlans = plans.filter((p) => HISTORIC_STATUSES.has(p.status));

  const hasInProgress = plans.some(
    (p) => p.status === 'pending_first_payment' || p.status === 'active',
  );
  const hasCompleted   = plans.some((p) => p.status === 'completed');
  const patientBlocked = hasInProgress && !hasCompleted;

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-10">
      <h1 className="text-2xl font-semibold mb-6" style={{ color: '#13294B' }}>Orders</h1>
      <OrdersView
        pendingPlans={pendingPlans}
        currentPlans={currentPlans}
        historicPlans={historicPlans}
        declinePlan={declinePlan}
        settleInstalment={selfSettleInstalment}
        settleEntirePlan={selfSettleEntirePlan}
        specialtyMap={specialtyMap}
        patientBlocked={patientBlocked}
      />
    </div>
  );
}
