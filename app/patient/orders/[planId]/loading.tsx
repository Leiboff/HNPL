import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { PatientDetailShape } from '@/components/loading/PatientShellShape';

// Route fallback for patient/orders/[planId]. Built on the real PatientScreen shell so the
// navy header and sheet are already correct while content loads — a generic
// light-grey page would flash the wrong background. See
// components/loading/PatientShellShape.tsx.
export default function Loading() {
  return (
    <DelayedSkeleton>
      <PatientDetailShape label="Loading plan details" cards={3} />
    </DelayedSkeleton>
  );
}
