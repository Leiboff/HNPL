// ─── Bucketing: how practices are grouped on the explore page ──────────
//
// Pure function — no React, no DOM, no Supabase — so it's unit-testable
// in isolation. The component (ExploreView.tsx) feeds it the filtered
// list + geo state + radius, and gets back the two visible buckets.
//
// The contract:
//
//   No user location (idle / requesting / denied / dismissed):
//     ALL approved practices go into `nearList` unsorted (preserves
//     the alphabetical order from the server-side query). `otherList`
//     is empty. No approved practice can be invisible in this state —
//     the "search by suburb" affordance is the user's tool for
//     narrowing down without sharing precise location, but until they
//     do, every approved practice in the list is reachable.
//
//   User location granted:
//     • Practices with coords AND within the radius → `nearList`,
//       sorted ascending by distanceKm.
//     • Practices with NO coords (latitude/longitude NULL) →
//       `otherList`, alphabetised by name — findable but not
//       distance-rankable.
//     • Practices with coords but BEYOND the radius → hidden. The
//       radius preset IS the user's chosen cap; honouring it is
//       intentional. A practice can leave hidden state by widening
//       the radius preset.
//
// Why both buckets matter: the explore page shows two distinct
// sections ("near me" + "other practices"). Beyond-radius hiding is
// only safe when the user IS using location — they expressed a
// preference. In every other state, NOTHING is hidden.

import type { PracticeCard } from './page';

export type PracticeWithDistance = PracticeCard & { distanceKm: number | null };

export type BucketResult = {
  nearList:  PracticeWithDistance[];
  otherList: PracticeWithDistance[];
};

/**
 * Split a flat list into the explore page's two buckets.
 *
 * @param items        Already search/specialty-filtered and
 *                     distance-decorated practices.
 * @param hasLocation  True only when the user has GRANTED location
 *                     (gps or suburb-picked). False covers
 *                     idle / requesting / denied / dismissed.
 * @param radiusKm     The user's chosen radius. Ignored when
 *                     hasLocation is false.
 */
export function bucketPractices(
  items:       PracticeWithDistance[],
  hasLocation: boolean,
  radiusKm:    number,
): BucketResult {
  if (!hasLocation) {
    // No location → every approved practice is visible. Preserve
    // the input order (server returned them alphabetised by name).
    return { nearList: items, otherList: [] };
  }

  const within:  PracticeWithDistance[] = [];
  const without: PracticeWithDistance[] = [];
  for (const p of items) {
    if (p.distanceKm == null) {
      without.push(p);
    } else if (p.distanceKm <= radiusKm) {
      within.push(p);
    }
    // beyond-radius coord-having: hidden by design (radius is the cap).
  }
  within.sort((a, b) => (a.distanceKm! - b.distanceKm!));
  without.sort((a, b) => a.name.localeCompare(b.name));
  return { nearList: within, otherList: without };
}
