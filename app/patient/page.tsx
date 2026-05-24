import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import SalaryDayForm from './SalaryDayForm';
import PendingPlanCard from './PendingPlanCard';
import { splitInstalments, calculatePaymentDates } from '@/lib/finance';

// ─── Types ────────────────────────────────────────────────────────────────────

type PaymentRow = {
  id: string;
  instalment_number: number;
  amount: number;
  due_date: string;
  status: string;
};

type PlanRow = {
  id: string;
  total_amount: number;
  plan_type: number | null;
  status: string;
  created_at: string;
  invoice_number: string | null;
  practice_reference: string | null;
  practices: { name: string } | { name: string }[] | null;
  payments: PaymentRow[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

function getPracticeName(plan: PlanRow): string {
  if (!plan.practices) return 'Unknown Practice';
  if (Array.isArray(plan.practices)) return plan.practices[0]?.name ?? 'Unknown Practice';
  return (plan.practices as { name: string }).name;
}

// ─── Status badges ────────────────────────────────────────────────────────────

const PLAN_STATUS: Record<string, { label: string; cls: string }> = {
  pending_acceptance:    { label: 'Awaiting approval',  cls: 'bg-amber-100 text-amber-800' },
  pending_first_payment: { label: 'Payment processing', cls: 'bg-blue-100 text-blue-700'   },
  active:                { label: 'Active',              cls: 'bg-green-100 text-green-700' },
  completed:             { label: 'Completed',           cls: 'bg-gray-100 text-gray-600'  },
  defaulted:             { label: 'Defaulted',           cls: 'bg-red-100 text-red-700'    },
  cancelled:             { label: 'Cancelled',           cls: 'bg-gray-100 text-gray-400'  },
  declined:              { label: 'Declined',            cls: 'bg-gray-100 text-gray-400'  },
};

function PlanStatusBadge({ status }: { status: string }) {
  const cfg = PLAN_STATUS[status] ?? { label: status, cls: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

const PAYMENT_STATUS: Record<string, { label: string; cls: string }> = {
  scheduled:   { label: 'Scheduled',   cls: 'bg-blue-50 text-blue-700'      },
  processing:  { label: 'Processing',  cls: 'bg-blue-100 text-blue-800'     },
  collected:   { label: 'Collected',   cls: 'bg-green-100 text-green-700'   },
  failed:      { label: 'Failed',      cls: 'bg-red-100 text-red-700'       },
  retried:     { label: 'Retried',     cls: 'bg-orange-100 text-orange-700' },
  written_off: { label: 'Written off', cls: 'bg-gray-100 text-gray-400'     },
};

function PaymentStatusBadge({ status }: { status: string }) {
  const cfg = PAYMENT_STATUS[status] ?? { label: status, cls: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

// ─── Server Actions ───────────────────────────────────────────────────────────

async function saveSalaryDay(day: number): Promise<{ error: string | null }> {
  'use server';

  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return { error: 'Salary day must be a whole number between 1 and 31.' };
  }

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Session expired. Please log in again.' };
  }

  const { error } = await supabase
    .from('profiles')
    .update({ salary_day: day })
    .eq('id', user.id);

  if (error) {
    return { error: error.message };
  }

  revalidatePath('/patient');
  return { error: null };
}

async function acceptPlan(planId: string, planType: 2 | 3): Promise<{ error: string | null }> {
  'use server';

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Not authenticated.' };
  }

  if (planType !== 2 && planType !== 3) {
    return { error: 'Invalid instalment count. Choose 2 or 3.' };
  }

  const { data: plan } = await supabase
    .from('plans')
    .select('id, total_amount, practice_id, application_id')
    .eq('id', planId)
    .eq('patient_id', user.id)
    .eq('status', 'pending_acceptance')
    .maybeSingle();

  if (!plan) {
    return { error: 'Plan not found or already actioned.' };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('salary_day')
    .eq('id', user.id)
    .single();

  const salaryDay = profile?.salary_day as number | null;
  if (!salaryDay) {
    return { error: 'Please set your salary date before accepting.' };
  }

  const totalAmount = Number(plan.total_amount);
  const instalments = splitInstalments(totalAmount, planType);
  const dates = calculatePaymentDates(new Date(), salaryDay, planType);

  const { error: planError } = await supabase
    .from('plans')
    .update({
      status: 'pending_first_payment',
      plan_type: planType,
      instalment_amount: instalments[0],
    })
    .eq('id', planId)
    .eq('patient_id', user.id);

  if (planError) {
    return { error: planError.message };
  }

  const paymentRows = instalments.map((amount, i) => ({
    id: crypto.randomUUID(),
    plan_id: planId,
    patient_id: user.id,
    instalment_number: i + 1,
    amount,
    due_date: dates[i].toISOString().split('T')[0],
    status: i === 0 ? 'processing' : 'scheduled',
  }));

  const { error: paymentsError } = await supabase
    .from('payments')
    .insert(paymentRows);

  if (paymentsError) {
    return { error: paymentsError.message };
  }

  if (plan.application_id) {
    await supabase
      .from('applications')
      .update({ plan_type: planType })
      .eq('id', plan.application_id as string);
  }

  revalidatePath('/patient');
  return { error: null };
}

async function declinePlan(planId: string): Promise<{ error: string | null }> {
  'use server';

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Not authenticated.' };
  }

  const { data: plan } = await supabase
    .from('plans')
    .select('id')
    .eq('id', planId)
    .eq('patient_id', user.id)
    .eq('status', 'pending_acceptance')
    .maybeSingle();

  if (!plan) {
    return { error: 'Plan not found or already actioned.' };
  }

  const { error: planError } = await supabase
    .from('plans')
    .update({ status: 'declined' })
    .eq('id', planId)
    .eq('patient_id', user.id);

  if (planError) {
    return { error: planError.message };
  }

  revalidatePath('/patient');
  return { error: null };
}

// ─── Plan card ────────────────────────────────────────────────────────────────

function PlanCard({ plan }: { plan: PlanRow }) {
  return (
    <div className="rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-gray-100">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-semibold text-gray-900">{getPracticeName(plan)}</p>
            <p className="text-sm mt-0.5 text-gray-500">
              {plan.plan_type != null ? `${plan.plan_type} monthly payments` : 'Payment plan'}
            </p>
            {plan.invoice_number && (
              <p className="font-mono text-xs text-gray-400 mt-1">{plan.invoice_number}</p>
            )}
            {plan.practice_reference && (
              <p className="text-xs text-gray-400">Practice ref: {plan.practice_reference}</p>
            )}
          </div>
          <div className="text-right shrink-0">
            <p className="text-lg font-semibold text-gray-900">
              R{Number(plan.total_amount).toFixed(2)}
            </p>
            <div className="mt-1">
              <PlanStatusBadge status={plan.status} />
            </div>
          </div>
        </div>
      </div>

      {/* Payment schedule */}
      <div className="bg-white divide-y divide-gray-100">
        {plan.payments.map((payment) => (
          <div key={payment.id} className="flex items-center justify-between px-6 py-3">
            <div className="text-sm">
              <span className="text-gray-700">Instalment {payment.instalment_number}</span>
              <span className="ml-2 text-xs text-gray-400">{formatDate(payment.due_date)}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-900">
                R{Number(payment.amount).toFixed(2)}
              </span>
              <PaymentStatusBadge status={payment.status} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PatientDashboardPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, salary_day')
    .eq('id', user.id)
    .single();

  const salaryDay: number | null = profile?.salary_day ?? null;

  const { data: rawPlans } = await supabase
    .from('plans')
    .select(`
      id, total_amount, plan_type, status, created_at,
      invoice_number, practice_reference,
      practices(name),
      payments(id, instalment_number, amount, due_date, status)
    `)
    .eq('patient_id', user.id)
    .order('created_at', { ascending: false });

  const plans: PlanRow[] = ((rawPlans ?? []) as PlanRow[]).map((p) => ({
    ...p,
    payments: [...(p.payments ?? [])].sort(
      (a, b) => a.instalment_number - b.instalment_number
    ),
  }));

  const pending    = plans.filter((p) => p.status === 'pending_acceptance');
  const processing = plans.filter((p) => p.status === 'pending_first_payment');
  const active     = plans.filter((p) => p.status === 'active');
  const completed  = plans.filter((p) => p.status === 'completed');
  const past       = plans.filter((p) => p.status === 'cancelled' || p.status === 'declined');

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 space-y-8">
        {/* Welcome */}
        <div>
          <h1 className="text-3xl font-semibold text-gray-900">Patient Dashboard</h1>
          <p className="mt-2 text-gray-500">
            Welcome, {profile?.first_name ?? user.email}
          </p>
        </div>

        {/* Salary day card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-base font-semibold text-gray-900">Your Salary Date</h2>

          {salaryDay !== null ? (
            <p className="mt-1 text-sm text-gray-600">
              Your payments are scheduled around the{' '}
              <span className="font-medium text-gray-900">{ordinal(salaryDay)}</span>{' '}
              of each month.
            </p>
          ) : (
            <p className="mt-1 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              Set your salary date so we can schedule your payments around payday.
            </p>
          )}

          <SalaryDayForm currentDay={salaryDay} saveSalaryDay={saveSalaryDay} />
        </div>

        {/* Plans */}
        {plans.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 py-16 text-center">
            <p className="font-medium text-gray-500">No payment plans yet</p>
            <p className="mt-1 text-sm text-gray-400">
              Plans will appear here when a practice creates a bill for you.
            </p>
          </div>
        ) : (
          <div className="space-y-10">
            {/* Pending acceptance — visually distinct */}
            {pending.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-4">
                  <svg
                    className="w-5 h-5 text-amber-500 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                    />
                  </svg>
                  <h2 className="text-lg font-semibold text-amber-900">Awaiting your approval</h2>
                </div>
                <div className="space-y-4">
                  {pending.map((plan) => (
                    <PendingPlanCard
                      key={plan.id}
                      planId={plan.id}
                      totalAmount={Number(plan.total_amount)}
                      salaryDay={salaryDay}
                      practiceName={getPracticeName(plan)}
                      invoiceNumber={plan.invoice_number}
                      practiceReference={plan.practice_reference}
                      acceptPlan={acceptPlan}
                      declinePlan={declinePlan}
                    />
                  ))}
                </div>
              </section>
            )}

            {processing.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-4">
                  <svg
                    className="w-5 h-5 text-blue-500 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                    />
                  </svg>
                  <h2 className="text-lg font-semibold text-blue-900">Payment processing</h2>
                </div>
                <p className="text-sm text-blue-700 mb-4">
                  Payment processing — your plan activates once your first payment is confirmed.
                </p>
                <div className="space-y-4">
                  {processing.map((plan) => <PlanCard key={plan.id} plan={plan} />)}
                </div>
              </section>
            )}

            {active.length > 0 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Active plans</h2>
                <div className="space-y-4">
                  {active.map((plan) => <PlanCard key={plan.id} plan={plan} />)}
                </div>
              </section>
            )}

            {completed.length > 0 && (
              <section>
                <h2 className="text-lg font-semibold text-gray-700 mb-4">Completed</h2>
                <div className="space-y-4">
                  {completed.map((plan) => <PlanCard key={plan.id} plan={plan} />)}
                </div>
              </section>
            )}

            {past.length > 0 && (
              <section>
                <h2 className="text-base font-medium text-gray-400 mb-3">Past</h2>
                <div className="space-y-3 opacity-60">
                  {past.map((plan) => <PlanCard key={plan.id} plan={plan} />)}
                </div>
              </section>
            )}
          </div>
        )}
    </div>
  );
}
