import PatientScreen from '@/app/patient/PatientScreen';
import SubScreenHeader from '../SubScreenHeader';
import NotificationsToggle from '@/app/patient/profile/NotificationsToggle';

// Was the "Notifications" AccordionSection body — now its own screen.
export default function NotificationsPage() {
  return (
    <PatientScreen header={<SubScreenHeader title="Notifications" />} sheetClassName="px-[18px] pt-5 pb-6">
      <div
        className="rounded-card bg-white p-[18px]"
        style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
      >
        <NotificationsToggle />
      </div>
    </PatientScreen>
  );
}
