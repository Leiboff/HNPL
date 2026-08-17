/**
 * Patient-area skeletons — built on the REAL shell.
 *
 * The patient surfaces don't use the generic page shapes, and reusing them
 * here would be actively wrong: every logged-in patient screen is the v4
 * navy shell (a dark header running to the top edge, a light sheet lifting
 * over it), and a generic light-grey page would flash the wrong background
 * colour across the whole viewport before snapping to navy. That reads far
 * worse than no skeleton at all.
 *
 * So these compose `PatientScreen` itself. It is a plain presentational
 * server component with no data dependencies, so the skeleton gets the
 * exact chrome, the exact overlap and the exact background the real screen
 * will have — only the content inside is grey. The swap is then invisible
 * apart from the text appearing.
 *
 * Note the patient LAYOUT owns the side nav and bottom nav and is not
 * re-rendered on a patient→patient navigation, so these deliberately model
 * only what the page owns.
 */

import PatientScreen from '@/app/patient/PatientScreen';
import {
  SkeletonRegion,
  SkeletonCard,
  SkeletonLine,
  SkeletonBlock,
  SkeletonRows,
} from './Skeleton';

/**
 * Header blocks are lighter than the body's grey: they sit on the navy
 * canvas, where gray-200 would be a glaring near-white patch. white/15
 * reads as "content pending" against the dark ground the way gray-200
 * does against the light sheet.
 */
const ON_NAVY = 'bg-white/15 motion-safe:animate-pulse';

function NavyLine({ w = 'w-32', h = 'h-4' }: { w?: string; h?: string }) {
  return <div aria-hidden className={`${h} ${w} rounded ${ON_NAVY}`} />;
}

/**
 * HOME — the balance hero in the navy header, then bill cards on the sheet.
 * /patient
 */
export function PatientHomeShape({ label = 'Loading your account' }: { label?: string }) {
  return (
    <SkeletonRegion label={label}>
      <PatientScreen
        header={
          <div className="space-y-3">
            <NavyLine w="w-24" h="h-3" />
            <NavyLine w="w-44" h="h-10" />
            <NavyLine w="w-36" h="h-3" />
          </div>
        }
      >
        <div className="space-y-4 px-[22px] py-6">
          <SkeletonCard className="space-y-3">
            <SkeletonLine w="w-28" h="h-3" />
            <SkeletonLine w="w-40" h="h-6" />
            <SkeletonBlock h="h-2" />
            <SkeletonLine w="w-32" h="h-3" />
          </SkeletonCard>
          <SkeletonCard className="space-y-3">
            <SkeletonLine w="w-24" h="h-3" />
            <SkeletonLine w="w-36" h="h-6" />
            <SkeletonBlock h="h-2" />
          </SkeletonCard>
        </div>
      </PatientScreen>
    </SkeletonRegion>
  );
}

/**
 * LIST — a title in the header, rows on the sheet.
 * /patient/orders, /patient/payment-methods
 */
export function PatientListShape({
  label = 'Loading',
  rows = 5,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <SkeletonRegion label={label}>
      <PatientScreen
        header={
          <div className="space-y-2">
            <NavyLine w="w-36" h="h-7" />
            <NavyLine w="w-48" h="h-3" />
          </div>
        }
      >
        <div className="px-[22px] py-6">
          <SkeletonCard>
            <SkeletonRows rows={rows} />
          </SkeletonCard>
        </div>
      </PatientScreen>
    </SkeletonRegion>
  );
}

/**
 * DETAIL — a back row and title in the header, detail cards on the sheet.
 * /patient/orders/[planId], /patient/account, /patient/profile
 */
export function PatientDetailShape({
  label = 'Loading details',
  cards = 2,
}: {
  label?: string;
  cards?: number;
}) {
  return (
    <SkeletonRegion label={label}>
      <PatientScreen
        header={
          <div className="space-y-3">
            <NavyLine w="w-16" h="h-3" />
            <NavyLine w="w-40" h="h-7" />
            <NavyLine w="w-28" h="h-3" />
          </div>
        }
      >
        <div className="space-y-4 px-[22px] py-6">
          {Array.from({ length: cards }).map((_, i) => (
            <SkeletonCard key={i} className="space-y-3">
              <SkeletonLine w="w-28" h="h-5" />
              <SkeletonLine w="w-full" />
              <SkeletonLine w="w-4/5" />
              <SkeletonLine w="w-2/3" />
            </SkeletonCard>
          ))}
        </div>
      </PatientScreen>
    </SkeletonRegion>
  );
}
