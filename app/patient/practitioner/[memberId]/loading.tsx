import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { SkeletonRegion, SkeletonCard, SkeletonCircle, SkeletonLine, SkeletonRows } from '@/components/loading/Skeleton';

// Route fallback for /patient/practitioner/[memberId]. This screen had no
// loading state at all before — DetailView is a plain white-background
// client component (no PatientScreen navy shell, unlike the rest of the
// patient area), so it gets its own shape matched to its real container
// (max-w-2xl, not the app's generic max-w-6xl) rather than reusing either
// the navy Patient*Shape or the generic DetailShape, both of which would
// visibly reflow on swap.
export default function Loading() {
  return (
    <DelayedSkeleton>
      <SkeletonRegion label="Loading practitioner" className="mx-auto max-w-2xl px-4 sm:px-5 py-6 sm:py-8 space-y-6">
        <SkeletonLine w="w-40" h="h-3" />
        <SkeletonCard className="flex items-start gap-4">
          <SkeletonCircle size="h-16 w-16" />
          <div className="flex-1 space-y-2 pt-1">
            <SkeletonLine w="w-48" h="h-6" />
            <SkeletonLine w="w-32" h="h-4" />
          </div>
        </SkeletonCard>
        <SkeletonCard>
          <SkeletonRows rows={2} />
        </SkeletonCard>
      </SkeletonRegion>
    </DelayedSkeleton>
  );
}
