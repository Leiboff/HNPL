import { describe, it, expect } from 'vitest';
import {
  decorateWithDistance,
  groupIntoCards,
  filterCards,
  bucketPractitionerCards,
  specialtiesFromCards,
  type DirectoryRow,
  type PractitionerCard,
} from './grouping';

// ─── Tests — practitioner discovery: group, distance, filter, bucket ──
//
// These pin the contract for the patient-facing "Find a Practitioner"
// page. The directory view (0064) hands us rows; this module is the
// entire client-side grouping + filtering surface, so getting these
// tests right gives the UI a load-bearing foundation.

function row(over: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    member_id:          'm-1',
    hpcsa_group_key:    null,
    hpcsa_registered:   false,
    first_name:         'Jane',
    last_name:          'Doe',
    specialty:          'Dentistry',
    practice_id:        'p-1',
    practice_name:      'Practice One',
    practice_suburb:    'Sandton',
    practice_city:      'Johannesburg',
    practice_latitude:  -26.10,
    practice_longitude:  28.05,
    practice_phone:     '+27 11 555 0001',
    ...over,
  };
}

// ─── decorateWithDistance ───────────────────────────────────────────────

describe('decorateWithDistance', () => {
  it('returns distanceKm=null on every row when userLocation is null', () => {
    const decorated = decorateWithDistance(
      [row({ practice_latitude: -26.10, practice_longitude: 28.05 })],
      null,
    );
    expect(decorated[0].distanceKm).toBeNull();
  });

  it('computes Haversine distance when userLocation is set and the practice has coords', () => {
    const me = { latitude: -26.10, longitude: 28.05 };
    const decorated = decorateWithDistance(
      [row({ practice_latitude: -26.10, practice_longitude: 28.05 })],
      me,
    );
    expect(decorated[0].distanceKm).toBeCloseTo(0, 1);
  });

  it('returns distanceKm=null on rows whose practice has no coords (even when user has location)', () => {
    const me = { latitude: -26.10, longitude: 28.05 };
    const decorated = decorateWithDistance(
      [row({ practice_latitude: null, practice_longitude: null })],
      me,
    );
    expect(decorated[0].distanceKm).toBeNull();
  });
});

// ─── groupIntoCards ─────────────────────────────────────────────────────

describe('groupIntoCards — merge by HPCSA, fallback to member_id', () => {
  it('two rows sharing an HPCSA group key → ONE card with two locations', () => {
    const rows = decorateWithDistance(
      [
        row({ member_id: 'm-a', hpcsa_group_key: 'hash-of-MP1234567', hpcsa_registered: true, practice_id: 'p-A', practice_name: 'Sandton Rooms' }),
        row({ member_id: 'm-b', hpcsa_group_key: 'hash-of-MP1234567', hpcsa_registered: true, practice_id: 'p-B', practice_name: 'Rosebank Rooms' }),
      ],
      null,
    );
    const cards = groupIntoCards(rows);
    expect(cards).toHaveLength(1);
    expect(cards[0].locations.map((l) => l.practice_name).sort())
      .toEqual(['Rosebank Rooms', 'Sandton Rooms']);
    expect(cards[0].hpcsaRegistered).toBe(true);
    expect(cards[0].id).toBe('hash-of-MP1234567');
  });

  it('two rows with DIFFERENT HPCSA keys → TWO cards', () => {
    const rows = decorateWithDistance(
      [
        row({ member_id: 'm-a', hpcsa_group_key: 'hash-A', first_name: 'Alice', practice_id: 'p-A' }),
        row({ member_id: 'm-b', hpcsa_group_key: 'hash-B', first_name: 'Bob',   practice_id: 'p-B' }),
      ],
      null,
    );
    const cards = groupIntoCards(rows);
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.firstName))).toEqual(new Set(['Alice', 'Bob']));
  });

  it('row with NULL hpcsa_group_key → standalone card keyed on member_id (NOT dropped)', () => {
    // This is the load-bearing "never hide a practitioner" rule.
    const rows = decorateWithDistance(
      [row({ member_id: 'm-x', hpcsa_group_key: null, hpcsa_registered: false, first_name: 'No', last_name: 'HPCSA' })],
      null,
    );
    const cards = groupIntoCards(rows);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('m:m-x');
    expect(cards[0].hpcsaRegistered).toBe(false);
  });

  it('two NULL-HPCSA rows → TWO standalone cards (each keyed on its own member_id)', () => {
    // NULL keys must NEVER merge with each other — different people who
    // happen to lack HPCSA on file are not the same person.
    const rows = decorateWithDistance(
      [
        row({ member_id: 'm-x', hpcsa_group_key: null, first_name: 'Alice', last_name: 'A' }),
        row({ member_id: 'm-y', hpcsa_group_key: null, first_name: 'Bob',   last_name: 'B' }),
      ],
      null,
    );
    const cards = groupIntoCards(rows);
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.firstName))).toEqual(new Set(['Alice', 'Bob']));
  });

  it('mixed HPCSA + NULL rows → grouped person + each NULL row as its own card', () => {
    const rows = decorateWithDistance(
      [
        row({ member_id: 'm-a', hpcsa_group_key: 'hash-X', first_name: 'Linked', practice_id: 'p-A' }),
        row({ member_id: 'm-b', hpcsa_group_key: 'hash-X', first_name: 'Linked', practice_id: 'p-B' }),
        row({ member_id: 'm-c', hpcsa_group_key: null,     first_name: 'Solo'                          }),
      ],
      null,
    );
    const cards = groupIntoCards(rows);
    expect(cards).toHaveLength(2);
    const linked = cards.find((c) => c.firstName === 'Linked')!;
    const solo   = cards.find((c) => c.firstName === 'Solo')!;
    expect(linked.locations).toHaveLength(2);
    expect(solo.locations).toHaveLength(1);
  });
});

// ─── Distance ordering on a card ───────────────────────────────────────

describe('groupIntoCards — distance ordering + minDistanceKm', () => {
  const me = { latitude: -26.10, longitude: 28.05 };

  it('sorts a card\'s locations nearest-first when user location is set', () => {
    const rows = decorateWithDistance(
      [
        // ~110 km away
        row({ member_id: 'm-a', hpcsa_group_key: 'hash', practice_id: 'p-far',  practice_name: 'Far',  practice_latitude: -25.10, practice_longitude:  28.05 }),
        // ~0 km
        row({ member_id: 'm-b', hpcsa_group_key: 'hash', practice_id: 'p-near', practice_name: 'Near', practice_latitude: -26.10, practice_longitude:  28.05 }),
      ],
      me,
    );
    const cards = groupIntoCards(rows);
    expect(cards).toHaveLength(1);
    expect(cards[0].locations.map((l) => l.practice_name)).toEqual(['Near', 'Far']);
    expect(cards[0].minDistanceKm).toBeCloseTo(0, 1);
  });

  it('puts coord-less locations LAST and minDistanceKm uses only coord-having locations', () => {
    const rows = decorateWithDistance(
      [
        row({ member_id: 'm-a', hpcsa_group_key: 'hash', practice_id: 'p-known',   practice_name: 'Known',   practice_latitude: -26.10, practice_longitude: 28.05 }),
        row({ member_id: 'm-b', hpcsa_group_key: 'hash', practice_id: 'p-unknown', practice_name: 'Unknown', practice_latitude: null,    practice_longitude: null   }),
      ],
      me,
    );
    const card = groupIntoCards(rows)[0];
    expect(card.locations.map((l) => l.practice_name)).toEqual(['Known', 'Unknown']);
    expect(card.locations[1].distanceKm).toBeNull();
    expect(card.minDistanceKm).toBeCloseTo(0, 1);
  });

  it('card with ALL coord-less locations → minDistanceKm is null', () => {
    const rows = decorateWithDistance(
      [
        row({ member_id: 'm-a', hpcsa_group_key: 'hash', practice_id: 'p-1', practice_latitude: null, practice_longitude: null }),
        row({ member_id: 'm-b', hpcsa_group_key: 'hash', practice_id: 'p-2', practice_latitude: null, practice_longitude: null }),
      ],
      me,
    );
    expect(groupIntoCards(rows)[0].minDistanceKm).toBeNull();
  });
});

// ─── filterCards ───────────────────────────────────────────────────────

describe('filterCards — search + specialty AND together', () => {
  const cards: PractitionerCard[] = [
    { id: 'c1', representativeMemberId: 'mc1', firstName: 'Alice',   lastName: 'Smith',  fullName: 'Alice Smith',  specialty: 'Dentistry',     hpcsaRegistered: true, locations: [], minDistanceKm: null },
    { id: 'c2', representativeMemberId: 'mc2', firstName: 'Bob',     lastName: 'Jones',  fullName: 'Bob Jones',    specialty: 'Physiotherapy', hpcsaRegistered: true, locations: [], minDistanceKm: null },
    { id: 'c3', representativeMemberId: 'mc3', firstName: 'Charlie', lastName: 'Doe',    fullName: 'Charlie Doe',  specialty: 'Dentistry',     hpcsaRegistered: false, locations: [], minDistanceKm: null },
  ];

  it('empty filters → all cards pass', () => {
    expect(filterCards(cards, '', null).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('search narrows by name (case-insensitive substring)', () => {
    expect(filterCards(cards, 'alice', null).map((c) => c.id)).toEqual(['c1']);
    expect(filterCards(cards, 'DOE',   null).map((c) => c.id)).toEqual(['c3']);
  });

  it('specialty narrows by exact match', () => {
    expect(filterCards(cards, '', 'Dentistry').map((c) => c.id)).toEqual(['c1', 'c3']);
    expect(filterCards(cards, '', 'Physiotherapy').map((c) => c.id)).toEqual(['c2']);
  });

  it('combined filters AND together', () => {
    expect(filterCards(cards, 'doe', 'Dentistry').map((c) => c.id)).toEqual(['c3']);
    expect(filterCards(cards, 'doe', 'Physiotherapy')).toEqual([]);
  });
});

// ─── bucketPractitionerCards ───────────────────────────────────────────

describe('bucketPractitionerCards — no-location state', () => {
  it('no location → ALL cards in nearList unsorted, otherList empty (never hide anyone)', () => {
    const cards: PractitionerCard[] = [
      { id: 'c1', representativeMemberId: 'mc1', firstName: 'A', lastName: 'A', fullName: 'A', specialty: null, hpcsaRegistered: true,  locations: [], minDistanceKm: null },
      { id: 'c2', representativeMemberId: 'mc2', firstName: 'B', lastName: 'B', fullName: 'B', specialty: null, hpcsaRegistered: false, locations: [], minDistanceKm: null },
    ];
    const r = bucketPractitionerCards(cards, false, 25);
    expect(r.nearList.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(r.otherList).toEqual([]);
  });
});

describe('bucketPractitionerCards — granted state with radius', () => {
  function card(over: Partial<PractitionerCard> = {}): PractitionerCard {
    return {
      id:                     'x',
      representativeMemberId: 'mx',
      firstName:              'X',
      lastName:               'X',
      fullName:               'X X',
      specialty:              null,
      hpcsaRegistered:        true,
      locations:              [],
      minDistanceKm:          null,
      ...over,
    };
  }

  it('cards with at least one within-radius location land in nearList, sorted by minDistanceKm', () => {
    const cards: PractitionerCard[] = [
      card({ id: 'far',     fullName: 'Far',     minDistanceKm: 20 }),
      card({ id: 'closest', fullName: 'Closest', minDistanceKm: 2  }),
      card({ id: 'middle',  fullName: 'Middle',  minDistanceKm: 9  }),
    ];
    const r = bucketPractitionerCards(cards, true, 25);
    expect(r.nearList.map((c) => c.id)).toEqual(['closest', 'middle', 'far']);
    expect(r.otherList).toEqual([]);
  });

  it('cards with ALL coord-less locations (minDistanceKm null) land in otherList alphabetised', () => {
    const cards: PractitionerCard[] = [
      card({ id: 'z', fullName: 'Zulu Solo',  minDistanceKm: null }),
      card({ id: 'a', fullName: 'Alpha Solo', minDistanceKm: null }),
    ];
    const r = bucketPractitionerCards(cards, true, 25);
    expect(r.nearList).toEqual([]);
    expect(r.otherList.map((c) => c.fullName)).toEqual(['Alpha Solo', 'Zulu Solo']);
  });

  it('a card whose NEAREST location is beyond radius is hidden (radius IS the cap)', () => {
    const cards: PractitionerCard[] = [
      card({ id: 'within', minDistanceKm: 8 }),
      card({ id: 'beyond', minDistanceKm: 80 }),
    ];
    const r = bucketPractitionerCards(cards, true, 25);
    expect(r.nearList.map((c) => c.id)).toEqual(['within']);
    expect(r.otherList).toEqual([]);
  });

  it('the "any-within-radius" rule is satisfied by minDistanceKm: a 2-location practitioner with one near + one far passes', () => {
    // The card represents a practitioner with two locations; the
    // minDistanceKm is the nearest one. If that nearest is within
    // the radius, the card appears (covering "ANY of their locations
    // is within the radius"); the far location stays on the card but
    // doesn't block visibility.
    const c = card({
      id: 'mixed',
      minDistanceKm: 5,
      locations: [
        { practice_id: 'near', practice_name: 'Near', suburb: null, city: null, phone: null, latitude: null, longitude: null, distanceKm: 5  },
        { practice_id: 'far',  practice_name: 'Far',  suburb: null, city: null, phone: null, latitude: null, longitude: null, distanceKm: 60 },
      ],
    });
    const r = bucketPractitionerCards([c], true, 25);
    expect(r.nearList).toHaveLength(1);
    expect(r.nearList[0].locations.map((l) => l.practice_name)).toEqual(['Near', 'Far']);
  });
});

// ─── specialtiesFromCards ───────────────────────────────────────────────

describe('specialtiesFromCards', () => {
  it('returns the distinct specialties alphabetised, skipping null', () => {
    const cards: PractitionerCard[] = [
      { id: 'c1', representativeMemberId: 'mc1', firstName: 'A', lastName: 'A', fullName: 'A', specialty: 'Dentistry',     hpcsaRegistered: true, locations: [], minDistanceKm: null },
      { id: 'c2', representativeMemberId: 'mc2', firstName: 'B', lastName: 'B', fullName: 'B', specialty: null,            hpcsaRegistered: true, locations: [], minDistanceKm: null },
      { id: 'c3', representativeMemberId: 'mc3', firstName: 'C', lastName: 'C', fullName: 'C', specialty: 'Dentistry',     hpcsaRegistered: true, locations: [], minDistanceKm: null },
      { id: 'c4', representativeMemberId: 'mc4', firstName: 'D', lastName: 'D', fullName: 'D', specialty: 'Physiotherapy', hpcsaRegistered: true, locations: [], minDistanceKm: null },
    ];
    expect(specialtiesFromCards(cards)).toEqual(['Dentistry', 'Physiotherapy']);
  });
});
