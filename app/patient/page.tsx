import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import LogoutButton from '@/app/dashboard/LogoutButton';
import SalaryDayForm from './SalaryDayForm';

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

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

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between">
          <span className="text-lg font-semibold text-gray-900">HNPL</span>
          <LogoutButton />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-12 space-y-6">
        <div>
          <h1 className="text-3xl font-semibold text-gray-900">
            Patient Dashboard
          </h1>
          <p className="mt-2 text-gray-500">
            Welcome, {profile?.first_name ?? user.email}
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-base font-semibold text-gray-900">
            Your Salary Date
          </h2>

          {salaryDay !== null ? (
            <p className="mt-1 text-sm text-gray-600">
              Your payments are scheduled around the{' '}
              <span className="font-medium text-gray-900">
                {ordinal(salaryDay)}
              </span>{' '}
              of each month.
            </p>
          ) : (
            <p className="mt-1 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              Set your salary date so we can schedule your payments around payday.
            </p>
          )}

          <SalaryDayForm
            currentDay={salaryDay}
            saveSalaryDay={saveSalaryDay}
          />
        </div>
      </main>
    </div>
  );
}
