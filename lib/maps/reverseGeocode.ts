'use client';

// ─── Reverse geocode — user lat/lng → suburb / area label ──────────────
//
// Client-side, best-effort, DISPLAY-ONLY. Called when the browser
// grants geolocation and we want to show "Near <suburb>" instead of
// the generic "Near your current location". The label is never
// persisted — same posture as the rest of the discovery location
// handling (POPIA: "your location is not saved").
//
// Why we use the Places API (New) SearchNearby endpoint and NOT the
// retired legacy REST integration:
//   The whole codebase migrated off the legacy Geocoding path in the
//   Places-New sweep. A strict regression test
//   (app/no-geocoding-api.test.ts) enforces the removal — no source
//   file may reference the retired endpoint URL or read the
//   server-only GOOGLE_MAPS_API_KEY. Reverse-geocoding via Places
//   (New) SearchNearby is the officially supported path with the
//   existing NEXT_PUBLIC_GOOGLE_PLACES_KEY:
//
//     POST https://places.googleapis.com/v1/places:searchNearby
//     body: {
//       includedTypes: ['point_of_interest'],   // any nearby thing with an address
//       locationRestriction: { circle: { center, radius } },
//       maxResultCount: 1,
//     }
//     headers: X-Goog-Api-Key,
//              X-Goog-FieldMask: 'places.addressComponents'
//
//   The address components on the returned Place contain the
//   sublocality (suburb) and locality (city) for that spot. In dense
//   ZA cities this is accurate within a suburb; in rural areas there
//   may be no POI within the radius and we fall back to null.
//
// This is best-effort:
//   • Missing API key → null.
//   • Non-2xx / thrown fetch → null (never throws).
//   • Empty results → null.
//   • Address components lack both suburb + city → null.
//
//   Every null triggers the "Near your current location" fallback in
//   the UI (already the copy today). Never a blank / error state.

const SEARCH_NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';

// Essentials-tier field mask — same discipline as fetchPlaceDetails.
const REVERSE_GEOCODE_FIELD_MASK = 'places.addressComponents,places.formattedAddress';

// 500 m radius: a POI within this range is almost always in the same
// suburb as the user. Widening it (5 km) risks pulling in an adjacent
// suburb's POI; narrowing it (100 m) risks empty responses in less
// dense areas. 500 m is the sweet spot on ZA urban / suburban maps.
const NEARBY_RADIUS_METERS = 500;

type AddressComponent = {
  longText:  string;
  shortText: string;
  types:     string[];
};

/**
 * Extract a `Suburb, City` label from Places addressComponents.
 * Returns null when neither a sublocality-like component nor a
 * locality component is present. Exported so unit tests can pin
 * the extraction rules without hitting the network.
 */
export function extractSuburbLabel(components: AddressComponent[]): string | null {
  let suburb: string | null = null;
  let city:   string | null = null;
  for (const c of components) {
    // Sublocality tags — Google returns different sublocality_level_*
    // variants depending on the area. Neighborhood is a reasonable
    // fallback when no sublocality is present.
    if (!suburb && c.types.some((t) =>
      t === 'sublocality'
      || t === 'sublocality_level_1'
      || t === 'sublocality_level_2'
      || t === 'neighborhood',
    )) {
      suburb = c.longText;
    }
    if (!city && c.types.includes('locality')) {
      city = c.longText;
    }
  }
  const label = [suburb, city].filter(Boolean).join(', ');
  return label || null;
}

/**
 * Best-effort reverse-geocode of lat/lng to a human-readable "Suburb,
 * City" label using Places (New) SearchNearby. Returns null on any
 * failure — the caller falls back to a generic label.
 *
 * This is called ONCE per location resolution (the discovery UI
 * caches the resolved label in component state; it doesn't re-hit
 * this on every render). See ExploreView's reverseGeocode effect.
 */
export async function reverseGeocodeSuburb(
  latitude:  number,
  longitude: number,
): Promise<string | null> {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY;
  if (!apiKey) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  try {
    const res = await fetch(SEARCH_NEARBY_URL, {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   apiKey,
        'X-Goog-FieldMask': REVERSE_GEOCODE_FIELD_MASK,
      },
      body: JSON.stringify({
        includedTypes: ['point_of_interest'],
        locationRestriction: {
          circle: {
            center: { latitude, longitude },
            radius: NEARBY_RADIUS_METERS,
          },
        },
        maxResultCount: 1,
      }),
    });

    if (!res.ok) {
      console.warn('[reverseGeocode] non-2xx', { status: res.status });
      return null;
    }

    const data = (await res.json().catch(() => null)) as {
      places?: Array<{
        addressComponents?: AddressComponent[];
        formattedAddress?:  string;
      }>;
    } | null;

    const first = data?.places?.[0];
    if (!first) return null;

    return extractSuburbLabel(first.addressComponents ?? []);
  } catch (err) {
    console.warn('[reverseGeocode] failed', { message: (err as Error).message });
    return null;
  }
}
