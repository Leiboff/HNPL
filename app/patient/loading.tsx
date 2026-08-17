import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { PatientHomeShape } from '@/components/loading/PatientShellShape';

// Route fallback for patient. Built on the real PatientScreen shell so the
// navy header and sheet are already correct while content loads — a generic
// light-grey page would flash the wrong background. See
// components/loading/PatientShellShape.tsx.
export default function Loading() {
  return (
    <DelayedSkeleton>
      <PatientHomeShape label="Loading your account" />
    </DelayedSkeleton>
  );
}
