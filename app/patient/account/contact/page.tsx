import { redirect } from 'next/navigation';
import PatientScreen from '@/app/patient/PatientScreen';
import SubScreenHeader from '../SubScreenHeader';
import PatientContactForm from './PatientContactForm';
import { getRequestUser } from '@/lib/auth/requestUser';

// ─── Contact us — its own screen, same conversion as every other row ────
//
// The signed-in counterpart to /contact (the public marketing form). That
// page asks a visitor who they are; this one already knows, so it never
// asks — no "you are a patient/practice" choice, no name/email/phone/ID
// fields. Those are read from the caller's own profile inside
// ./actions.ts's submitPatientContactEnquiry, never shown here and never
// accepted from the client. The one thing this screen collects is the
// message.
//
// Auth-gated the same way as every /patient/account/* sub-screen — the
// action re-checks independently (getRequestUser again), because a screen
// render and a subsequent form submission are different requests and
// neither may trust the other's authorisation.

export default async function PatientContactPage() {
  const user = await getRequestUser();
  if (!user) redirect('/login');

  return (
    <PatientScreen header={<SubScreenHeader title="Contact us" />} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[14px]">
        <p className="text-[13px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
          We already have your name, email, phone number and ID on file, so there&rsquo;s no need
          to type them again — we&rsquo;ll include them automatically. Just tell us what&rsquo;s up.
        </p>
        <PatientContactForm />
      </div>
    </PatientScreen>
  );
}
