import { redirect } from 'next/navigation';
import Link from 'next/link';
import PatientScreen from '../PatientScreen';
import ScanView from './ScanView';
import { getRequestUser } from '@/lib/auth/requestUser';

// ─── /patient/scan ─────────────────────────────────────────────────────
//
// The centre tab of the mobile bottom nav (see ../PatientBottomNav.tsx).
// No data to fetch — this is just the auth gate + navy header shell around
// the client scanner in ./ScanView.tsx.

export default async function ScanPage() {
  const user = await getRequestUser();
  if (!user) redirect('/login');

  const header = (
    <div className="flex items-center gap-3">
      <Link
        href="/patient"
        aria-label="Back to home"
        className="flex-none w-[38px] h-[38px] rounded-full flex items-center justify-center"
        style={{ background: 'rgba(255,255,255,.12)' }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m15 6-6 6 6 6" />
        </svg>
      </Link>
      <span className="text-[15.5px] font-semibold text-white truncate">Scan a checkout code</span>
    </div>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <ScanView />
    </PatientScreen>
  );
}
