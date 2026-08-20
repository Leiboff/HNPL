import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PatientScreen from '@/app/patient/PatientScreen';
import SubScreenHeader from '../SubScreenHeader';
import PhoneField from '@/app/patient/profile/PhoneField';
import SalaryDaySection from '@/app/patient/profile/SalaryDaySection';
import SalaryAmountSection from '@/app/patient/profile/SalaryAmountSection';
import ProfileFieldRow, { type ProfileFieldIconName } from '@/components/ProfileFieldRow';
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
 * A field the patient cannot change here. No lock icon and no per-field
 * reason any more — the single "Contact support" line at the bottom of the
 * card covers why, in one place instead of three times. Renders through the
 * same ProfileFieldRow shape as the editable fields below it, just with no
 * action slot, so the whole card reads as one uniformly-spaced list.
 */
function LockedField({
  icon,
  label,
  value,
}: {
  icon:  ProfileFieldIconName;
  label: string;
  value: string;
}) {
  return (
    <ProfileFieldRow icon={icon} label={label} testId="locked-field">
      <p className="text-sm font-medium text-gray-800 truncate">{value || '—'}</p>
    </ProfileFieldRow>
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
        className="rounded-[22px] bg-white p-[18px] divide-y divide-gray-100"
        style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
      >
        <LockedField icon="name" label="Full name" value={fullName} />
        <LockedField icon="id" label="SA ID number" value={saIdMasked || ''} />
        <LockedField icon="email" label="Email" value={emailMasked} />

        <PhoneField
          current={profile?.phone ?? null}
          pending={(profile?.phone_pending as string | null | undefined) ?? null}
          verifiedAt={(profile?.phone_verified_at as string | null | undefined) ?? null}
          startPhoneChange={startPhoneChange}
          requestPhoneChangeOtp={requestPhoneChangeOtp}
          verifyPhoneChangeOtp={verifyPhoneChangeOtp}
          cancelPhoneChange={cancelPhoneChange}
        />

        <SalaryDaySection current={salaryDay} saveSalaryDay={saveSalaryDay} />

        <SalaryAmountSection current={salaryAmount} saveSalaryAmount={saveSalaryAmount} />

        <p className="text-xs py-4 first:pt-0 last:pb-0" style={{ color: '#A3B1C2' }}>
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
