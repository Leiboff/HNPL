import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { DashboardShape } from '@/components/loading/shapes';

// Route fallback for admin. Shape-matched via the shared compositions —
// see components/loading/shapes.tsx. Wrapped in DelayedSkeleton so a fast
// response shows nothing rather than flashing (components/loading/timing.ts).
export default function Loading() {
  return (
    <DelayedSkeleton>
      <DashboardShape label="Loading the admin overview" />
    </DelayedSkeleton>
  );
}
