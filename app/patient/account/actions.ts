'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { isAllowedSalaryDay, ALLOWED_SALARY_DAYS } from '@/lib/salaryDates';
import { isValidSalaryAmount } from '@/lib/salaryAmount';

// ─── Salary server actions — moved out of page.tsx ────────────────────
//
// Personal details now lives at its own route (./personal/page.tsx)
// rather than being built inline on the account index page, so these
// two actions moved to a neutral module both can reach without one
// importing the other's page file.


// ─── Why these two writes are privileged now ───────────────────────────
//
// Migration 0122 turned the profiles column lock into an ALLOW-LIST, and
// salary_day / salary_amount are deliberately NOT on it (audit F-05).
//
// They could have been — a patient edits both from this very screen — and
// the reason they are not is that a column a patient can PATCH directly is
// a column whose validator is decorative. isAllowedSalaryDay and
// isValidSalaryAmount are right here, three lines up, and before this
// change a request that skipped them landed in the same column just the
// same. salary_amount feeds the affordability step, so "whatever the
// caller sent" was the wrong contract for it.
//
// So the validation stays where it is and the WRITE moves behind it.
function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// Changes apply to FUTURE plans only — a plan's own `salary_day` column is
// snapshotted at plan creation, so existing schedules are untouched. The
// profile is the salary_day source of truth; checkout READS it server-side.
export async function saveSalaryDay(day: number): Promise<{ error: string | null }> {
  if (!isAllowedSalaryDay(day)) {
    return { error: `Salary day must be one of: ${ALLOWED_SALARY_DAYS.join(', ')}.` };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { error } = await svc()
    .from('profiles')
    .update({ salary_day: day })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient/account/personal');
  revalidatePath('/patient');
  return { error: null };
}

// Same posture as saveSalaryDay: patient-editable, not read by any pricing
// or scheduling logic today (see migration 0100 / lib/salaryAmount.ts).
export async function saveSalaryAmount(amount: number): Promise<{ error: string | null }> {
  if (!isValidSalaryAmount(amount)) {
    return { error: 'Enter how much you earn a month.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { error } = await svc()
    .from('profiles')
    .update({ salary_amount: amount })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient/account/personal');
  revalidatePath('/patient');
  return { error: null };
}
