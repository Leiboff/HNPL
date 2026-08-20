import PatientScreen from '@/app/patient/PatientScreen';
import SubScreenHeader from '../SubScreenHeader';
import ProfileLogoutSection from '@/app/patient/profile/ProfileLogoutSection';

// Was the "Sign out" AccordionSection body — now its own screen. Still
// behind a tap-through rather than a permanently-visible red button on
// the index, same progressive-disclosure reasoning ProfileLogoutSection
// documents; a screen is one more tap than a collapsed section, which is
// the right amount of friction for a destructive, rarely-used action.
export default function SignOutPage() {
  return (
    <PatientScreen header={<SubScreenHeader title="Sign out" />} sheetClassName="px-[18px] pt-5 pb-6">
      <div
        className="rounded-[22px] bg-white p-[18px]"
        style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
      >
        <ProfileLogoutSection />
      </div>
    </PatientScreen>
  );
}
