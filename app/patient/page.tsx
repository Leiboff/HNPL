import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import SalaryDayForm from './SalaryDayForm';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

// ─── Server Action ────────────────────────────────────────────────────────────

async function saveSalaryDay(day: number): Promise<{ error: string | null }> {
  'use server';

  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return { error: 'Salary day must be a whole number between 1 and 31.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { error } = await supabase
    .from('profiles')
    .update({ salary_day: day })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient');
  return { error: null };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PatientDashboardPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: profile }, { data: planStatuses }] = await Promise.all([
    supabase
      .from('profiles')
      .select('first_name, salary_day')
      .eq('id', user.id)
      .single(),
    supabase
      .from('plans')
      .select('status')
      .eq('patient_id', user.id),
  ]);

  const salaryDay: number | null = (profile?.salary_day as number | null) ?? null;

  const allPlans     = planStatuses ?? [];
  const totalCount   = allPlans.length;
  const pendingCount = allPlans.filter((p) => p.status === 'pending_acceptance').length;
  const currentCount = allPlans.filter((p) =>
    ['pending_acceptance', 'pending_first_payment', 'active'].includes(p.status)
  ).length;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">

      {/* Welcome */}
      <div>
        <h1 className="text-3xl font-semibold text-gray-900">Dashboard</h1>
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

      {/* Plans summary */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Your Plans</h2>
          {totalCount > 0 && (
            <a href="/patient/orders" className="text-sm font-medium text-blue-600 hover:text-blue-700">
              View all →
            </a>
          )}
        </div>

        {totalCount === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 py-14 text-center">
            <p className="font-medium text-gray-500">No payment plans yet</p>
            <p className="mt-1 text-sm text-gray-400">
              Plans will appear here when a practice sends you a bill.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Pending-acceptance callout */}
            {pendingCount > 0 && (
              <a
                href="/patient/orders"
                className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4 hover:bg-amber-100 transition-colors"
              >
                <svg
                  className="w-5 h-5 text-amber-500 shrink-0 mt-0.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                  aria-hidden
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                  />
                </svg>
                <div>
                  <p className="font-medium text-amber-900 text-sm">
                    You have {pendingCount} plan{pendingCount !== 1 ? 's' : ''} awaiting your approval
                  </p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    Review and choose your payment schedule in Orders
                  </p>
                </div>
              </a>
            )}

            {/* Current plans count */}
            <div className="bg-white border border-gray-200 rounded-2xl px-5 py-4 flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  Current plans
                </p>
                <p className="text-2xl font-semibold text-gray-900 mt-0.5 tabular-nums">
                  {currentCount}
                </p>
              </div>
              <a
                href="/patient/orders"
                className="text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                View all orders →
              </a>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
