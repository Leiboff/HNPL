import { describe, it, expect } from 'vitest';
import { bucketPractices, type PracticeWithDistance } from './bucket';

// ─── Tests — explore page bucketing rule ───────────────────────────────
//
// Pins the load-bearing invariant for the patient explore page:
//
//   No-location state (idle / requesting / denied / dismissed):
//     EVERY approved practice appears in nearList, regardless of
//     whether it has coordinates. This is the fix for bug 1 — pre-fix,
//     practices with coords were silently hidden by the radius filter
//     even when there was no user location to measure against.
//
//   Granted state:
//     • Coord-having within radius → nearList sorted ascending by km.
//     • Coord-less → otherList alphabetised.
//     • Coord-having beyond radius → hidden by design (radius is the
//       user's chosen cap).

function p(over: Partial<PracticeWithDistance> = {}): PracticeWithDistance {
  return {
    id:         'p',
    name:       'Practice',
    specialty:  null,
    phone:      null,
    email:      null,
    suburb:     null,
    city:       null,
    latitude:   null,
    longitude:  null,
    distanceKm: null,
    ...over,
  };
}

describe('bucketPractices — no-location state shows every approved practice', () => {
  it('returns ALL practices in nearList when hasLocation is false (mixed coords)', () => {
    // Bug 1 repro: pre-fix, the coord-having practice "Cross Road"
    // disappeared in the no-location state. Pin that it now shows.
    const items: PracticeWithDistance[] = [
      p({ id: 'cross-road',     name: 'Cross Road Therapy', latitude: -26.10, longitude: 28.05, distanceKm: null }),
      p({ id: 'norwood',        name: 'Norwood Medical',    latitude: null,    longitude: null,  distanceKm: null }),
      p({ id: 'another-coord',  name: 'Sandton Clinic',     latitude: -26.10, longitude: 28.05, distanceKm: null }),
    ];
    const { nearList, otherList } = bucketPractices(items, false, 25);
    expect(nearList.map((x) => x.id)).toEqual(['cross-road', 'norwood', 'another-coord']);
    expect(otherList).toEqual([]);
  });

  it('preserves the input order (alphabetical from the server query) when hasLocation is false', () => {
    const items: PracticeWithDistance[] = [
      p({ id: 'a', name: 'Alpha',   distanceKm: null }),
      p({ id: 'b', name: 'Bravo',   distanceKm: null }),
      p({ id: 'c', name: 'Charlie', distanceKm: null }),
    ];
    const { nearList } = bucketPractices(items, false, 25);
    expect(nearList.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not split coord-less practices into an "Other practices" bucket when hasLocation is false', () => {
    // "Other practices" is a granted-state affordance only. In the
    // no-location state, every practice is uniformly listed — splitting
    // into Near/Other without a location to measure against would be
    // confusing and was the root cause of bug 1's invisible practices.
    const items: PracticeWithDistance[] = [
      p({ id: 'no-coord',   name: 'No Coord',     latitude: null,    longitude: null,  distanceKm: null }),
      p({ id: 'has-coord',  name: 'Has Coord',    latitude: -26.10, longitude: 28.05, distanceKm: null }),
    ];
    const { nearList, otherList } = bucketPractices(items, false, 25);
    expect(otherList).toEqual([]);
    expect(nearList).toHaveLength(2);
  });

  it('ignores the radius value entirely when hasLocation is false (no filter applied)', () => {
    const items: PracticeWithDistance[] = [
      p({ id: 'a', distanceKm: null }),
      p({ id: 'b', distanceKm: null }),
    ];
    const tight = bucketPractices(items, false, 5);
    const wide  = bucketPractices(items, false, 100);
    expect(tight.nearList.map((x) => x.id)).toEqual(['a', 'b']);
    expect(wide.nearList.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('bucketPractices — granted state keeps the radius-as-cap behaviour', () => {
  it('sorts within-radius by ascending distance (nearest first)', () => {
    const items: PracticeWithDistance[] = [
      p({ id: 'far',   distanceKm: 18, latitude: -26.10, longitude: 28.05 }),
      p({ id: 'near',  distanceKm: 2,  latitude: -26.10, longitude: 28.05 }),
      p({ id: 'mid',   distanceKm: 9,  latitude: -26.10, longitude: 28.05 }),
    ];
    const { nearList } = bucketPractices(items, true, 25);
    expect(nearList.map((x) => x.id)).toEqual(['near', 'mid', 'far']);
  });

  it('puts coord-less practices in otherList alphabetised by name', () => {
    const items: PracticeWithDistance[] = [
      p({ id: 'z', name: 'Zulu Medical',     distanceKm: null }),
      p({ id: 'a', name: 'Alpha Practice',    distanceKm: null }),
      p({ id: 'm', name: 'Mango Clinic',      distanceKm: null }),
    ];
    const { nearList, otherList } = bucketPractices(items, true, 25);
    expect(nearList).toEqual([]);
    expect(otherList.map((x) => x.name)).toEqual(['Alpha Practice', 'Mango Clinic', 'Zulu Medical']);
  });

  it('hides coord-having practices beyond the radius — the cap IS the cap', () => {
    // This is the deliberately-preserved granted-state behaviour the
    // brief calls out. A user with location turned on has explicitly
    // chosen a radius; we honour their cap.
    const items: PracticeWithDistance[] = [
      p({ id: 'within',    distanceKm: 8,  latitude: -26.10, longitude: 28.05 }),
      p({ id: 'beyond',    distanceKm: 80, latitude: -26.10, longitude: 28.05 }),
    ];
    const { nearList, otherList } = bucketPractices(items, true, 25);
    expect(nearList.map((x) => x.id)).toEqual(['within']);
    expect(otherList).toEqual([]); // beyond-radius is hidden, NOT moved to other.
  });

  it('mixes the three populations correctly (within / coord-less / beyond)', () => {
    const items: PracticeWithDistance[] = [
      p({ id: 'nearby',     name: 'Nearby',      distanceKm: 4,  latitude: -26.10, longitude: 28.05 }),
      p({ id: 'no-coord',   name: 'No Coord',    distanceKm: null }),
      p({ id: 'far-away',   name: 'Far Away',    distanceKm: 50, latitude: -26.10, longitude: 28.05 }),
    ];
    const { nearList, otherList } = bucketPractices(items, true, 25);
    expect(nearList.map((x) => x.id)).toEqual(['nearby']);
    expect(otherList.map((x) => x.id)).toEqual(['no-coord']);
  });
});
