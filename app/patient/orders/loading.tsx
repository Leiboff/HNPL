import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { PatientListShape } from '@/components/loading/PatientShellShape';

// Route fallback for patient/orders. Built on the real PatientScreen shell so the
// navy header and sheet are already correct while content loads — a generic
// light-grey page would flash the wrong background. See
// components/loading/PatientShellShape.tsx.
export default function Loading() {
  return (
    <DelayedSkeleton>
      <PatientListShape label="Loading your plans" rows={5} />
    </DelayedSkeleton>
  );
}
