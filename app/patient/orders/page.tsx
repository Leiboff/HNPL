import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { declinePlan } from '../actions';
import OrdersView from './OrdersView';

// ─── Status buckets ───────────────────────────────────────────────────────────

const CURRENT_STATUSES  = new Set(['pending_acceptance', 'pending_first_payment', 'active']);
const HISTORIC_STATUSES = new Set(['completed', 'declined', 'cancelled', 'defaulted']);

// ─── Types (shared with OrdersView via props) ─────────────────────────────────

export type PaymentRow = {
  id: string;
  instalment_number: number;
  amount: number;
  due_date: string;
  status: string;
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
      provider_id, practice_id,
      provider:profiles!plans_provider_id_fkey(first_name, last_name),
      practice:practices(name),
      payments(id, instalment_number, amount, due_date, status)
    `)
    .eq('patient_id', user.id)
    .order('created_at', { ascending: false });

  const plans = ((rawPlans ?? []) as unknown as PlanRow[]).map((p) => ({
    ...p,
    payments: [...(p.payments ?? [])].sort(
      (a, b) => a.instalment_number - b.instalment_number
    ),
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

  const currentPlans  = plans.filter((p) => CURRENT_STATUSES.has(p.status));
  const historicPlans = plans.filter((p) => HISTORIC_STATUSES.has(p.status));

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Orders</h1>
      <OrdersView
        currentPlans={currentPlans}
        historicPlans={historicPlans}
        declinePlan={declinePlan}
        specialtyMap={specialtyMap}
      />
    </div>
  );
}
