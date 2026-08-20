import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PatientScreen from '@/app/patient/PatientScreen';
import SubScreenHeader from '../SubScreenHeader';
import PhoneField from '@/app/patient/profile/PhoneField';
import SalaryDaySection from '@/app/patient/profile/SalaryDaySection';
import SalaryAmountSection from '@/app/patient/profile/SalaryAmountSection';
import { saveSalaryDay, saveSalaryAmount } from '../actions';
import {
  startPhoneChange,
  requestPhoneChangeOtp,
  verifyPhoneChangeOtp,
  cancelPhoneChange,
} from '../phoneChangeActions';
import { decryptIdForDisplay } from '@/lib/idEncryption';
import { maskSaId } from '@/lib/saIdMask';
import { maskEmail } from '@/lib/patient/maskContact';
import { getRequestUser } from '@/lib/auth/requestUser';

// ─── Personal details — its own screen ────────────────────────────────
//
// Was an AccordionSection body on /patient/account; is now a real,
// linkable, back-navigable screen, same conversion as every other
// former section (see SubScreenHeader.tsx).
//
// Salary date and salary amount live HERE now, not as their own sibling
// section/screen — direct product decision (2026-08-20): both are
// personal-details fields, same as the identity fields above them. This
// reverses the earlier "salary date deserves its own section because its
// consequences differ from every other field" argument that used to live
// in AccountSettings.tsx; that reasoning is gone along with the section
// split, on purpose, per explicit direction rather than as a byproduct of
// the accordion→screens conversion.
//
// The two deep links that used to target `?section=salary` /
// `?section=personal` (app/(auth)/verify-phone/page.tsx,
// app/patient/orders/[planId]/confirm/page.tsx) both now point straight
// at this route — there is only one destination for "go edit your salary
// info" or "go edit your phone" now, so there is nothing left for a query
// param to disambiguate.

/**
 * A field the patient cannot change, shown as visibly locked WITH its reason.
 */
function LockedField({
  label,
  value,
  reason,
}: {
  label:  string;
  value:  string;
  reason: string;
}) {
  return (
    <div data-testid="locked-field">
      <p
        className="text-[11px] font-semibold uppercase tracking-widest mb-1.5"
        style={{ color: '#13294B', opacity: 0.45 }}
      >
        {label}
      </p>
      <div className="flex items-center gap-1.5">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#8496AA"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-none"
          aria-label="Locked"
          role="img"
          data-testid="locked-field-icon"
        >
          <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
          <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
        </svg>
        <p className="text-sm font-medium text-gray-800 truncate">{value || '—'}</p>
      </div>
      <p className="mt-1 text-[11.5px] leading-[1.45]" style={{ color: '#A3B1C2' }}>
        {reason}
      </p>
    </div>
  );
}

export default async function PersonalDetailsPage() {
  const supabase = await createClient();

  const user = await getRequestUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name, email, phone, phone_pending, phone_verified_at, sa_id_number, salary_day, salary_amount')
    .eq('id', user.id)
    .single();

  const firstName = (profile?.first_name as string | null) ?? '';
  const lastName  = (profile?.last_name  as string | null) ?? '';
  const fullName  = [firstName, lastName].filter(Boolean).join(' ') || '—';

  const decryptedSaId = decryptIdForDisplay(profile?.sa_id_number as string | null | undefined);
  const saIdMasked    = maskSaId(decryptedSaId);
  const emailMasked   = maskEmail(profile?.email as string | null | undefined);
  const salaryDay     = (profile?.salary_day    as number | null) ?? null;
  const salaryAmount  = (profile?.salary_amount as number | null) ?? null;

  return (
    <PatientScreen header={<SubScreenHeader title="Personal details" />} sheetClassName="px-[18px] pt-5 pb-6">
      <div
        className="rounded-[22px] bg-white p-[18px] flex flex-col gap-4"
        style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
          <LockedField
            label="Full name"
            value={fullName}
            reason="Must match your SA ID. Support can change it."
          />
          <LockedField
            label="SA ID number"
            value={saIdMasked || ''}
            reason="Verified at signup and fixed for life."
          />
          <LockedField
            label="Email"
            value={emailMasked}
            reason="Your sign-in address. Support can change it."
          />
        </div>

        <div className="border-t border-gray-100 pt-4">
          <PhoneField
            current={profile?.phone ?? null}
            pending={(profile?.phone_pending as string | null | undefined) ?? null}
            verifiedAt={(profile?.phone_verified_at as string | null | undefined) ?? null}
            startPhoneChange={startPhoneChange}
            requestPhoneChangeOtp={requestPhoneChangeOtp}
            verifyPhoneChangeOtp={verifyPhoneChangeOtp}
            cancelPhoneChange={cancelPhoneChange}
          />
        </div>

        <div className="border-t border-gray-100 pt-4">
          <SalaryDaySection current={salaryDay} saveSalaryDay={saveSalaryDay} />
        </div>

        <div className="border-t border-gray-100 pt-4">
          <SalaryAmountSection current={salaryAmount} saveSalaryAmount={saveSalaryAmount} />
        </div>

        <p className="text-xs border-t border-gray-100 pt-4" style={{ color: '#A3B1C2' }}>
          Locked fields protect your account.{' '}
          <a href="mailto:support@betternow.co.za" className="underline underline-offset-2 hover:text-gray-600 transition-colors">
            Contact support
          </a>{' '}
          if one of them is wrong.
        </p>
      </div>
    </PatientScreen>
  );
}
