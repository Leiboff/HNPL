import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import LogoutButton from '@/app/dashboard/LogoutButton';
import SalaryDayForm from './SalaryDayForm';
import PlanActions from './PlanActions';

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
  plan_type: number;
  status: string;
  created_at: string;
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
  pending_acceptance: { label: 'Awaiting approval', cls: 'bg-amber-100 text-amber-800' },
  active:             { label: 'Active',             cls: 'bg-green-100 text-green-700' },
  completed:          { label: 'Completed',          cls: 'bg-gray-100 text-gray-600'  },
  defaulted:          { label: 'Defaulted',          cls: 'bg-red-100 text-red-700'    },
  cancelled:          { label: 'Cancelled',          cls: 'bg-gray-100 text-gray-400'  },
  declined:           { label: 'Declined',           cls: 'bg-gray-100 text-gray-400'  },
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

async function acceptPlan(planId: string): Promise<{ error: string | null }> {
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
    .update({ status: 'active' })
    .eq('id', planId)
    .eq('patient_id', user.id);

  if (planError) {
    return { error: planError.message };
  }

  const { error: paymentError } = await supabase
    .from('payments')
    .update({ status: 'collected', collected_at: new Date().toISOString() })
    .eq('plan_id', planId)
    .eq('instalment_number', 1)
    .eq('patient_id', user.id);

  if (paymentError) {
    return { error: paymentError.message };
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
  const isPending = plan.status === 'pending_acceptance';

  return (
    <div className={`rounded-2xl border overflow-hidden ${
      isPending ? 'border-amber-300' : 'border-gray-200 shadow-sm'
    }`}>
      {/* Header */}
      <div className={`px-6 py-4 border-b ${
        isPending ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-100'
      }`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className={`font-semibold ${isPending ? 'text-amber-900' : 'text-gray-900'}`}>
              {getPracticeName(plan)}
            </p>
            <p className={`text-sm mt-0.5 ${isPending ? 'text-amber-700' : 'text-gray-500'}`}>
              {plan.plan_type} monthly payments
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className={`text-lg font-semibold ${isPending ? 'text-amber-900' : 'text-gray-900'}`}>
              R{Number(plan.total_amount).toFixed(2)}
            </p>
            <div className="mt-1">
              <PlanStatusBadge status={plan.status} />
            </div>
          </div>
        </div>
      </div>

      {/* Payment schedule */}
      <div className={`divide-y ${isPending ? 'bg-amber-50 divide-amber-100' : 'bg-white divide-gray-100'}`}>
        {plan.payments.map((payment) => (
          <div key={payment.id} className="flex items-center justify-between px-6 py-3">
            <div className="text-sm">
              <span className={isPending ? 'text-amber-900' : 'text-gray-700'}>
                Instalment {payment.instalment_number}
              </span>
              <span className={`ml-2 text-xs ${isPending ? 'text-amber-600' : 'text-gray-400'}`}>
                {formatDate(payment.due_date)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className={`text-sm font-medium ${isPending ? 'text-amber-900' : 'text-gray-900'}`}>
                R{Number(payment.amount).toFixed(2)}
              </span>
              <PaymentStatusBadge status={payment.status} />
            </div>
          </div>
        ))}
      </div>

      {/* Accept / Decline */}
      {isPending && (
        <div className="px-6 py-4 bg-amber-50 border-t border-amber-200">
          <PlanActions planId={plan.id} acceptPlan={acceptPlan} declinePlan={declinePlan} />
        </div>
      )}
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
    .select('role, first_name, salary_day')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'patient') {
    if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') {
      redirect('/practice');
    } else if (profile?.role === 'admin') {
      redirect('/admin');
    } else {
      redirect('/login');
    }
  }

  const salaryDay: number | null = profile?.salary_day ?? null;

  const { data: rawPlans } = await supabase
    .from('plans')
    .select(`
      id, total_amount, plan_type, status, created_at,
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

  const pending   = plans.filter((p) => p.status === 'pending_acceptance');
  const active    = plans.filter((p) => p.status === 'active');
  const completed = plans.filter((p) => p.status === 'completed');
  const past      = plans.filter((p) => p.status === 'cancelled' || p.status === 'declined');

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between">
          <span className="text-lg font-semibold text-gray-900">HNPL</span>
          <LogoutButton />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-12 space-y-8">
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
                  {pending.map((plan) => <PlanCard key={plan.id} plan={plan} />)}
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
      </main>
    </div>
  );
}
