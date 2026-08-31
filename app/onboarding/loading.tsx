import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { AuthSurfaceShape } from '@/components/loading/shapes';

// Route fallback for onboarding. Shape-matched via the shared compositions —
// see components/loading/shapes.tsx. The steps render on the navy auth
// surface, so the fallback does too (`progress` adds the step rail);
// the old light FormShape flashed a white page before every step.
// Wrapped in DelayedSkeleton so a fast response shows nothing rather than
// flashing (components/loading/timing.ts).
export default function Loading() {
  return (
    <DelayedSkeleton>
      <AuthSurfaceShape label="Loading the next step" fields={2} progress />
    </DelayedSkeleton>
  );
}
