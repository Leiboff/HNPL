import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import PatientScreen from '../PatientScreen';
import InstalmentLadder, { type LadderSegment } from '../InstalmentLadder';
import PaymentMethods from '../payment-methods/PaymentMethods';
import PhoneField from '../profile/PhoneField';
import SalaryDaySection from '../profile/SalaryDaySection';
import NotificationsToggle from '../profile/NotificationsToggle';
import PasskeysSection from '../profile/PasskeysSection';
import ProfileLogoutSection from '../profile/ProfileLogoutSection';
import AccountAccordion from './AccountAccordion';
import { initializeCardRegistration } from '../actions';
import { deriveInstalmentStatus } from '@/lib/patient/instalmentStatus';
import { todaySAST } from '../_format';
import { decryptIdForDisplay } from '@/lib/idEncryption';
import { maskSaId } from '@/lib/saIdMask';
import { isAllowedSalaryDay, ALLOWED_SALARY_DAYS } from '@/lib/salaryDates';
import { normalizePhoneZA } from '@/lib/validation';
import {
  previewDefaultChange,
  changeDefaultCard,
  removeCard,
  type CardRow,
} from '../payment-methods/actions';

// ─── Account — the single settings surface (v4, consolidated) ────────────
//
// Account and Profile are now ONE page, ONE pattern. A navy header carries
// the identity; the sheet holds the honest payment record, the settings
// accordion (Personal details — with phone + salary date nested — then
// Notifications and Security & sign-in), the card-management surface
// ("How you pay"), and a single Help + Log out. The old /patient/profile
// route redirects here, so there is exactly one place for each control.
//
// Honesty (per the build decision): "Your record" shows the count of
// payments actually made — no invented rewards tier, no "we'll review your
// limit" promise (that policy doesn't exist in code).

// ─── Server actions (moved here from the retired profile route) ──────────

async function updateProfile(data: { phone: string | null }): Promise<{ error: string | null }> {
  'use server';

  // Trust-boundary validation (the client validates too, but this is the
  // real gate). Empty clears the number; anything else must normalise to a
  // valid SA mobile — stored in canonical E.164 (+27…) form.
  const raw = data.phone?.trim() ?? '';
  let phone: string | null = null;
  if (raw) {
    phone = normalizePhoneZA(raw);
    if (!phone) return { error: 'Enter a valid South African mobile number.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { error } = await supabase
    .from('profiles')
    .update({ phone })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient/account');
  return { error: null };
}

// Changes apply to FUTURE plans only — a plan's own `salary_day` column is
// snapshotted at plan creation, so existing schedules are untouched. The
// profile is the salary_day source of truth; checkout READS it server-side.
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

  revalidatePath('/patient/account');
  revalidatePath('/patient');
  return { error: null };
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#B6C1CD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#13294B', opacity: 0.45 }}>{label}</p>
      <p className="text-sm font-medium text-gray-800">{value || '—'}</p>
    </div>
  );
}

export default async function AccountPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: profile }, { data: rawCards }, { data: rawPayments }] = await Promise.all([
    supabase
      .from('profiles')
      .select('first_name, last_name, email, phone, sa_id_number, salary_day')
      .eq('id', user.id)
      .single(),
    supabase
      .from('payment_methods')
      .select('id, card_brand, last_four, expiry_month, expiry_year, cardholder_name, is_default, created_at')
      .eq('patient_id', user.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase.from('payments').select('status, due_date, next_attempt_date').eq('patient_id', user.id).eq('kind', 'instalment'),
  ]);

  const firstName = (profile?.first_name as string | null) ?? '';
  const lastName  = (profile?.last_name  as string | null) ?? '';
  const fullName  = [firstName, lastName].filter(Boolean).join(' ') || '—';
  const initials  = [firstName[0], lastName[0]].filter(Boolean).join('').toUpperCase() || '?';
  const salaryDay = (profile?.salary_day as number | null) ?? null;

  const decryptedSaId = decryptIdForDisplay(profile?.sa_id_number as string | null | undefined);
  const saIdMasked    = maskSaId(decryptedSaId);

  const cards = (rawCards ?? []) as CardRow[];

  // ── Honest payment record ─────────────────────────────────────────
  // "All on time" is only true when nothing is currently overdue AND there
  // is no history of a miss. Overdue is derived (due date vs today) via the
  // shared source of truth — the same verdict the Plans header and schedule
  // show — so this card can never contradict them.
  const today       = todaySAST();
  const instalments = (rawPayments ?? []) as { status: string; due_date: string; next_attempt_date: string | null }[];
  const statuses    = instalments.map((p) => p.status);
  const madeCount   = statuses.filter((s) => s === 'collected').length;
  const scheduled   = statuses.filter((s) => s === 'scheduled').length;
  const everMissed  = statuses.some((s) => s === 'failed' || s === 'defaulted' || s === 'retried');
  const anyOverdue  = instalments.some((p) => deriveInstalmentStatus(p, today) === 'overdue');
  const cleanRecord = madeCount > 0 && !everMissed && !anyOverdue;

  const CAP = 8;
  const paidSeg   = Math.min(madeCount, CAP);
  const comingSeg = Math.min(scheduled, CAP - paidSeg);
  const recordSegments: LadderSegment[] = [
    ...Array(paidSeg).fill('paid' as LadderSegment),
    ...Array(comingSeg).fill('coming' as LadderSegment),
  ];

  const recordHeading =
    madeCount === 0 ? 'No payments yet' :
    cleanRecord     ? `${madeCount} payment${madeCount === 1 ? '' : 's'}, all on time` :
                      `${madeCount} payment${madeCount === 1 ? '' : 's'} made`;

  const header = (
    <div className="flex items-center gap-[14px]">
      <span
        className="flex-none w-[52px] h-[52px] rounded-full flex items-center justify-center text-[17px] font-semibold text-white"
        style={{ background: 'rgba(255,255,255,.14)' }}
      >
        {initials}
      </span>
      <div className="min-w-0">
        <p className="text-[19px] font-semibold text-white truncate" style={{ letterSpacing: '-.02em' }}>{fullName}</p>
        <p className="mt-0.5 text-[13px] truncate" style={{ color: 'rgba(255,255,255,.6)' }}>{profile?.email ?? ''}</p>
      </div>
    </div>
  );

  // ── Personal details body — locked identity + phone + nested salary ──
  const personalDetails = (
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
      <div className="border-t border-gray-100 pt-4">
        <SalaryDaySection current={salaryDay} saveSalaryDay={saveSalaryDay} />
      </div>
      <p className="text-xs text-gray-400 border-t border-gray-100 pt-4">
        Name, SA ID and email are locked for security.{' '}
        <a href="mailto:support@betternow.co.za" className="underline underline-offset-2 hover:text-gray-600 transition-colors">
          Contact support
        </a>{' '}
        if these need to change.
      </p>
    </div>
  );

  // ── How you pay — the single card-management surface ─────────────────
  const howYouPay = (
    <div className="flex flex-col gap-[10px]">
      <p className="text-[11px] font-semibold uppercase px-1" style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.5)' }}>How you pay</p>
      <p className="px-1 text-[12.5px] leading-[1.5]" style={{ color: '#8496AA' }}>
        Your card details are never stored on betternow — they&rsquo;re held by our PCI-DSS
        certified payment partner. We only keep a secure reference to collect your instalments.
      </p>
      <PaymentMethods
        initialCards={cards}
        initializeCardRegistration={initializeCardRegistration}
        previewDefaultChange={previewDefaultChange}
        changeDefaultCard={changeDefaultCard}
        removeCard={removeCard}
      />
    </div>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[14px]">

        {/* Your record */}
        <div
          className="rounded-[22px] bg-white p-[18px] flex flex-col gap-[14px]"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.5)' }}>Your record</p>
              <p className="mt-2 text-[17px] font-semibold" style={{ color: '#13294B' }}>{recordHeading}</p>
            </div>
            {cleanRecord && (
              <span className="flex-none w-[34px] h-[34px] rounded-full flex items-center justify-center" style={{ background: 'rgba(21,168,158,.13)', color: '#0F766E' }}>
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 10.5l3 3 7-7" />
                </svg>
              </span>
            )}
          </div>
          {recordSegments.length > 0 && <InstalmentLadder segments={recordSegments} />}
          <p className="text-[13px] leading-[1.55]" style={{ color: '#8496AA' }}>
            {madeCount === 0
              ? 'Your payment record builds here as you pay each instalment on time.'
              : 'Every payment you keep on time builds your record with betternow.'}
          </p>
        </div>

        {/* Settings — one accordion pattern; cards ("How you pay") sit
            inline between Personal details and the rest. */}
        <AccountAccordion
          personalDetails={personalDetails}
          howYouPay={howYouPay}
          notifications={<NotificationsToggle />}
          security={<PasskeysSection />}
        />

        {/* Help + Log out — once. */}
        <div
          className="rounded-[22px] bg-white overflow-hidden"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          <a
            href="mailto:support@betternow.co.za"
            className="flex items-center justify-between gap-3 px-[18px] py-[17px] hover:bg-gray-50 transition-colors"
          >
            <div className="min-w-0">
              <p className="text-[14.5px] font-semibold" style={{ color: '#13294B' }}>Get help</p>
            </div>
            <Chevron />
          </a>
        </div>

        <ProfileLogoutSection />

      </div>
    </PatientScreen>
  );
}
