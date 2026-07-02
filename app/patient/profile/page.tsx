import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import PhoneField from './PhoneField';
import SalaryDaySection from './SalaryDaySection';
import PasskeysSection from './PasskeysSection';
import ProfileAccordion from './ProfileAccordion';
import NotificationsToggle from './NotificationsToggle';
import { decryptIdForDisplay } from '@/lib/idEncryption';
import { maskSaId } from '@/lib/saIdMask';
import { isAllowedSalaryDay, ALLOWED_SALARY_DAYS } from '@/lib/salaryDates';

async function updateProfile(data: { phone: string | null }): Promise<{ error: string | null }> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { error } = await supabase
    .from('profiles')
    .update({ phone: data.phone })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient/profile');
  return { error: null };
}

// ─── saveSalaryDay ────────────────────────────────────────────────────
//
// Moved from /patient (dashboard) to /patient/profile as part of the
// "profile is the salary_day source of truth" decision. The dashboard
// no longer sets salary_day; checkout READS it server-side. Changes
// apply to FUTURE plans only — a plan's own `salary_day` column is
// snapshotted at plan creation, so existing schedules are untouched.

async function saveSalaryDay(day: number): Promise<{ error: string | null }> {
  'use server';

  if (!isAllowedSalaryDay(day)) {
    return { error: `Salary day must be one of: ${ALLOWED_SALARY_DAYS.join(', ')}.` };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { error } = await supabase
    .from('profiles')
    .update({ salary_day: day })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient/profile');
  revalidatePath('/patient');
  return { error: null };
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#13294B', opacity: 0.45 }}>{label}</p>
      <p className="text-sm font-medium text-gray-800">{value || '—'}</p>
    </div>
  );
}

export default async function ProfilePage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name, email, phone, sa_id_number, salary_day')
    .eq('id', user.id)
    .single();

  const decryptedSaId = decryptIdForDisplay(profile?.sa_id_number);
  const saIdMasked    = maskSaId(decryptedSaId);

  const firstName = profile?.first_name ?? '';
  const lastName  = profile?.last_name  ?? '';
  const fullName  = [firstName, lastName].filter(Boolean).join(' ');
  const initials  = [firstName[0], lastName[0]].filter(Boolean).join('').toUpperCase() || '?';
  const salaryDay: number | null = (profile?.salary_day as number | null) ?? null;

  const card = 'bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm';

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-5 py-6 sm:py-8 space-y-4">

      {/* Header — avatar + name only, always visible */}
      <div className={`${card} p-5 flex items-center gap-4`}>
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center shrink-0 text-white text-lg font-bold select-none"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {initials}
        </div>
        <p className="font-semibold text-gray-900 truncate min-w-0">
          {fullName || '—'}
        </p>
      </div>

      {/* Accordion */}
      <ProfileAccordion
        personalDetails={
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
              <ReadOnlyField label="First name"   value={firstName} />
              <ReadOnlyField label="Last name"    value={lastName} />
              <ReadOnlyField label="SA ID number" value={saIdMasked || ''} />
              <ReadOnlyField label="Email"        value={profile?.email ?? ''} />
            </div>
            <div className="border-t border-gray-100 pt-4">
              <PhoneField current={profile?.phone ?? null} updateProfile={updateProfile} />
            </div>
            <p className="text-xs text-gray-400 border-t border-gray-100 pt-4">
              Name, SA ID and email are locked for security.{' '}
              <a href="mailto:support@betternow.co.za" className="underline underline-offset-2 hover:text-gray-600 transition-colors">
                Contact support
              </a>{' '}
              if these need to change.
            </p>
          </div>
        }
        salaryDay={<SalaryDaySection current={salaryDay} saveSalaryDay={saveSalaryDay} />}
        notifications={<NotificationsToggle />}
        passkeys={<PasskeysSection />}
      />

    </div>
  );
}
