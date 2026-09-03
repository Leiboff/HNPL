import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { FormShape } from '@/components/loading/shapes';

// Route fallback for /security (two-factor management). Shape-matched via the
// shared compositions — see components/loading/shapes.tsx. Wrapped in
// DelayedSkeleton so a fast response shows nothing rather than flashing
// (components/loading/timing.ts).
export default function Loading() {
  return (
    <DelayedSkeleton>
      <FormShape label="Loading two-factor settings" />
    </DelayedSkeleton>
  );
}
