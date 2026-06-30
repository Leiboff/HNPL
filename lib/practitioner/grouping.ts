// ─── Practitioner discovery — pure grouping + distance helpers ────────
//
// Takes raw rows from `practitioners_directory` (one row per
// practitioner-at-a-practice) and produces a list of
// PRACTITIONER CARDS (one per human). A practitioner working at two
// approved practices appears as ONE card listing both locations.
//
// Grouping key
//   hpcsa_group_key (md5 of the trimmed/lowercased HPCSA on the row)
//   when non-null; otherwise the row's member_id (each null-HPCSA row
//   is its own card — never hidden because the merge key is absent).
//
// Distance — applied client-side using Haversine before grouping:
//   • A location's `distanceKm` is null when (a) the user has no
//     location set OR (b) the practice has no coords.
//   • A card's `minDistanceKm` is the smallest non-null distanceKm
//     across its locations; null when all locations are coord-less.
//   • Locations on a card are sorted: nulls last, then ascending by km.
//
// HPCSA exposure
//   Cards expose ONLY `hpcsaRegistered: boolean` ("HPCSA registered ✓"
//   trust badge). The raw HPCSA number never leaves the database —
//   the view exposed the md5 hash + the boolean; this helper hands
//   the client only the boolean.

import { haversineKm, type LatLng } from '@/lib/maps/haversine';

// ─── Shapes ────────────────────────────────────────────────────────────

export type DirectoryRow = {
  member_id:          string;
  hpcsa_group_key:    string | null;
  hpcsa_registered:   boolean;
  first_name:         string;
  last_name:          string;
  specialty:          string | null;
  practice_id:        string;
  practice_name:      string;
  practice_suburb:    string | null;
  practice_city:      string | null;
  practice_latitude:  number | null;
  practice_longitude: number | null;
  practice_phone:     string | null;
};

export type LocationOnCard = {
  practice_id:   string;
  practice_name: string;
  suburb:        string | null;
  city:          string | null;
  phone:         string | null;
  distanceKm:    number | null;
};

export type PractitionerCard = {
  // Stable id used as React key. Derived from hpcsa_group_key when
  // available; otherwise from the standalone member_id.
  id:               string;
  firstName:        string;
  lastName:         string;
  fullName:         string;
  specialty:        string | null;
  hpcsaRegistered:  boolean;
  locations:        LocationOnCard[];   // sorted nearest-first; nulls last
  minDistanceKm:    number | null;      // min across locations (null if all null)
};

// ─── Pure helpers ──────────────────────────────────────────────────────

/**
 * Decorate each row with distanceKm. When `userLocation` is null, every
 * row gets null (the no-location contract — never hide anyone on the
 * basis of distance we can't compute).
 */
export function decorateWithDistance(
  rows:         DirectoryRow[],
  userLocation: LatLng | null,
): Array<DirectoryRow & { distanceKm: number | null }> {
  if (userLocation == null) {
    return rows.map((r) => ({ ...r, distanceKm: null }));
  }
  return rows.map((r) => {
    if (r.practice_latitude == null || r.practice_longitude == null) {
      return { ...r, distanceKm: null };
    }
    const km = haversineKm(userLocation, {
      latitude:  r.practice_latitude,
      longitude: r.practice_longitude,
    });
    return { ...r, distanceKm: km };
  });
}

/**
 * Group rows by hpcsa_group_key (fallback to member_id when null).
 * Returns PractitionerCard[] with locations sorted nearest-first
 * (nulls last) and minDistanceKm computed.
 *
 * The hpcsa_group_key fallback to member_id is the load-bearing rule
 * for the "null HPCSA still appears" requirement.
 */
export function groupIntoCards(
  rows: Array<DirectoryRow & { distanceKm: number | null }>,
): PractitionerCard[] {
  const byKey = new Map<string, PractitionerCard>();

  for (const r of rows) {
    // hpcsa_group_key non-null → all rows sharing it merge.
    // hpcsa_group_key null     → member_id is the key, so each such
    //                            row is its own standalone card.
    //                            We prefix with 'm:' so a future md5
    //                            collision with a member_id is
    //                            impossible (different namespaces).
    const groupId = r.hpcsa_group_key ?? `m:${r.member_id}`;

    const location: LocationOnCard = {
      practice_id:   r.practice_id,
      practice_name: r.practice_name,
      suburb:        r.practice_suburb,
      city:          r.practice_city,
      phone:         r.practice_phone,
      distanceKm:    r.distanceKm,
    };

    const existing = byKey.get(groupId);
    if (existing) {
      // Don't double-add the same practice — a defensive de-dupe in
      // case the view ever returns duplicate (member_id, practice_id)
      // rows (shouldn't happen given UNIQUE (practice_id, user_id) on
      // practice_members, but cheap to guard).
      if (!existing.locations.some((l) => l.practice_id === r.practice_id)) {
        existing.locations.push(location);
      }
    } else {
      byKey.set(groupId, {
        id:              groupId,
        firstName:       r.first_name,
        lastName:        r.last_name,
        fullName:        `${r.first_name} ${r.last_name}`.trim(),
        specialty:       r.specialty,
        hpcsaRegistered: r.hpcsa_registered,
        locations:       [location],
        minDistanceKm:   null,  // computed after all rows are in
      });
    }
  }

  for (const card of byKey.values()) {
    // Sort locations: nulls last, then ascending by distance.
    card.locations.sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) return 0;
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });
    // min across non-null distances; null if all null.
    const knownDistances = card.locations
      .map((l) => l.distanceKm)
      .filter((d): d is number => d != null);
    card.minDistanceKm = knownDistances.length === 0 ? null : Math.min(...knownDistances);
  }

  return Array.from(byKey.values());
}

// ─── Filters + bucketing ───────────────────────────────────────────────

/**
 * Filter cards by:
 *   • text search (matches first/last name; case-insensitive contains),
 *   • specialty (exact match; null = no filter).
 *
 * Distance-based filtering happens in bucketPractitionerCards below —
 * splitting concerns so this function is just the AND combinator for
 * search + specialty + (implicitly) the radius rule applied later.
 */
export function filterCards(
  cards:        PractitionerCard[],
  search:       string,
  specialty:    string | null,
): PractitionerCard[] {
  const q = search.trim().toLowerCase();
  return cards.filter((c) => {
    const matchesSearch    = !q || c.fullName.toLowerCase().includes(q);
    const matchesSpecialty = !specialty || c.specialty === specialty;
    return matchesSearch && matchesSpecialty;
  });
}

/**
 * Bucket cards into near (within radius) vs other (cards with no
 * coord-having location) — same shape as the practices bucketer, so
 * the explore view can render with one rule.
 *
 *   • hasLocation = false → ALL cards in nearList unsorted; otherList
 *     empty. This is the no-location contract: never hide anyone.
 *   • hasLocation = true:
 *     - card has minDistanceKm <= radiusKm → nearList (sorted by min)
 *     - card has minDistanceKm == null (all locations coord-less)
 *       → otherList
 *     - card has minDistanceKm > radiusKm → hidden (radius IS the cap)
 *
 * Filtering on "any location within radius" is satisfied by
 * minDistanceKm <= radiusKm — the min is, by definition, the
 * closest location, so this is equivalent to ANY-within-radius.
 */
export type BucketResult = {
  nearList:  PractitionerCard[];
  otherList: PractitionerCard[];
};

export function bucketPractitionerCards(
  cards:       PractitionerCard[],
  hasLocation: boolean,
  radiusKm:    number,
): BucketResult {
  if (!hasLocation) {
    return { nearList: cards, otherList: [] };
  }

  const within:  PractitionerCard[] = [];
  const without: PractitionerCard[] = [];
  for (const c of cards) {
    if (c.minDistanceKm == null) {
      without.push(c);
    } else if (c.minDistanceKm <= radiusKm) {
      within.push(c);
    }
    // beyond-radius cards hidden by design.
  }
  within.sort((a, b) => (a.minDistanceKm! - b.minDistanceKm!));
  without.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { nearList: within, otherList: without };
}

/**
 * Extract the distinct specialties from a list of cards. Used to
 * populate the specialty filter chips on the explore page.
 */
export function specialtiesFromCards(cards: PractitionerCard[]): string[] {
  const seen = new Set<string>();
  for (const c of cards) {
    if (c.specialty) seen.add(c.specialty);
  }
  return Array.from(seen).sort();
}
