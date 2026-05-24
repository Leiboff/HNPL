import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { acceptPlan, declinePlan } from '../actions';
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

export type PlanRow = {
  id: string;
  invoice_number: string | null;
  practice_reference: string | null;
  total_amount: number;
  plan_type: number | null;
  status: string;
  created_at: string;
  practices: { name: string } | { name: string }[] | null;
  payments: PaymentRow[];
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function OrdersPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: rawPlans }, { data: profile }] = await Promise.all([
    supabase
      .from('plans')
      .select(`
        id, invoice_number, practice_reference,
        total_amount, plan_type, status, created_at,
        practices(name),
        payments(id, instalment_number, amount, due_date, status)
      `)
      .eq('patient_id', user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('profiles')
      .select('salary_day')
      .eq('id', user.id)
      .single(),
  ]);

  const plans = ((rawPlans ?? []) as unknown as PlanRow[]).map((p) => ({
    ...p,
    payments: [...(p.payments ?? [])].sort(
      (a, b) => a.instalment_number - b.instalment_number
    ),
  }));

  const currentPlans  = plans.filter((p) => CURRENT_STATUSES.has(p.status));
  const historicPlans = plans.filter((p) => HISTORIC_STATUSES.has(p.status));
  const salaryDay     = (profile?.salary_day as number | null) ?? null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Orders</h1>
      <OrdersView
        currentPlans={currentPlans}
        historicPlans={historicPlans}
        salaryDay={salaryDay}
        acceptPlan={acceptPlan}
        declinePlan={declinePlan}
      />
    </div>
  );
}
