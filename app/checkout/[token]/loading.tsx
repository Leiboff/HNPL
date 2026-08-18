import DelayedSkeleton from '@/components/loading/DelayedSkeleton';
import {
  SkeletonRegion,
  SkeletonLine,
  SkeletonBlock,
} from '@/components/loading/Skeleton';

// ─── Checkout fallback — the highest-stakes one in the app ─────────────
//
// /checkout/[token] is 13 serial round trips, the second-slowest route
// here, and it is reached by scanning a QR at a practice counter on a phone
// on a mobile network. Nothing rendered for two seconds while a receptionist
// watches over your shoulder is exactly the "is this broken?" moment this
// work exists to remove, and it is the one place where the user's response
// to a frozen screen is to walk away from a payment.
//
// Deliberately NOT one of the generic shapes: checkout has its own chrome
// (a narrow centred card on #FAFBFD with a slim header bar), and this
// mirrors it so the real page appears in place rather than replacing a
// differently-shaped grey page.
//
// It also stays deliberately vague about content. The skeleton is public —
// anyone with a link, or a stranger glancing at the phone, sees it before
// any auth or token check has resolved — so it shows structure only, never
// an amount, a practice name or anything else that would leak what the
// token refers to.

export default function Loading() {
  return (
    <DelayedSkeleton>
      <SkeletonRegion label="Loading your payment plan" className="min-h-screen bg-[#FAFBFD]">
        <div className="border-b border-[#E5E9F0] bg-white">
          <div className="mx-auto flex max-w-md items-center justify-between px-5 py-4">
            <SkeletonLine w="w-28" h="h-5" />
            <SkeletonLine w="w-16" h="h-4" />
          </div>
        </div>

        <main className="mx-auto max-w-md space-y-5 px-5 py-8 sm:py-10">
          <div className="rounded-[20px] border border-[#E5E9F0] bg-white p-8 space-y-5">
            <div className="space-y-2">
              <SkeletonLine w="w-24" h="h-3" />
              <SkeletonLine w="w-40" h="h-9" />
            </div>
            <SkeletonBlock h="h-px" className="rounded-none" />
            <div className="space-y-3">
              <SkeletonLine w="w-full" />
              <SkeletonLine w="w-5/6" />
              <SkeletonLine w="w-2/3" />
            </div>
            <SkeletonBlock h="h-12" />
          </div>
        </main>
      </SkeletonRegion>
    </DelayedSkeleton>
  );
}
