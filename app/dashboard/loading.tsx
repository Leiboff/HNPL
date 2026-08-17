import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import { SkeletonRegion, SkeletonLine } from '@/components/loading/Skeleton';

// ─── /dashboard — the one place a SPINNER is right, not a skeleton ─────
//
// The general rule in this work is skeletons over spinners, because a
// skeleton says what is arriving. Here nothing is arriving: /dashboard is
// the role dispatcher. It reads profiles.role and redirects to /patient,
// /practice, /provider, /admin or /crm, and renders no content of its own.
//
// So there is no shape to promise. A skeleton would draw a page that never
// appears — it would imply "your content is loading here" immediately before
// the viewport is replaced by a different area entirely, which is a worse
// lie than a neutral wait. A small centred indicator is the honest signal
// for "working out where you belong".
//
// Still delayed, and still announced: an already-warm role lookup resolves
// well under the threshold and shows nothing at all.

export default function Loading() {
  return (
    <DelayedSkeleton>
      <SkeletonRegion
        label="Signing you in"
        className="flex min-h-screen items-center justify-center bg-[#f7fbfb] px-4"
      >
        <div className="flex flex-col items-center gap-4">
          {/* motion-safe so reduced-motion users get a static ring; the
              region's accessible label is what carries the meaning for
              them, which is the whole reason it is never the only cue. */}
          <div
            aria-hidden
            className="h-8 w-8 rounded-full border-2 border-gray-200 border-t-[#13294B] motion-safe:animate-spin"
          />
          <SkeletonLine w="w-32" h="h-3" />
        </div>
      </SkeletonRegion>
    </DelayedSkeleton>
  );
}
