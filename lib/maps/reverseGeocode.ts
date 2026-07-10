// ─── Reverse geocode — client wrapper + shared extractor ───────────────
//
// DISPLAY-ONLY helper for turning a user's lat/lng into a
// "Suburb, City" label on the LocationRow. The actual Google call
// happens SERVER-SIDE in app/api/reverse-geocode/route.ts. Rationale:
//
//   • Autocomplete + Place Details (lib/maps/places.ts) still run in
//     the browser on NEXT_PUBLIC_GOOGLE_PLACES_KEY — Places (New)
//     accepts HTTP-referrer-restricted keys.
//   • The legacy Geocoding web service REJECTS referrer-restricted
//     keys. Any browser call to that endpoint with our browser key
//     403s in production while passing mocked tests. So the reverse
//     geocode goes through the server route with a server-only
//     GOOGLE_GEOCODING_SERVER_KEY.
//   • Places (New) SearchNearby (the previous reverse-geocode path)
//     returns nothing in POI-sparse areas — most residential SA —
//     which stranded the change-location sheet on "Resolving
//     suburb…". Geocoding returns address components for ANY coord.
//
// This wrapper preserves the previous contract:
//   • Same signature — reverseGeocodeSuburb(lat, lng): Promise<string | null>.
//   • Same null-on-any-failure guarantee — never throws.
//   • The d0f6d42 fallback in ChangeLocationSheet (5s timeout, catch,
//     'Current location' default) sits on top and is untouched.
//
// The pure extractor lives here too — reused by the server route via
// the Places-New-shaped {longText, shortText, types} normalizer.

const REVERSE_GEOCODE_ROUTE = '/api/reverse-geocode';

type AddressComponent = {
  longText:  string;
  shortText: string;
  types:     string[];
};

/**
 * Extract a `Suburb, City` label from Places-New addressComponents.
 * Returns null when neither a sublocality-like component nor a
 * locality component is present. Exported so the API route can call
 * it after normalizing legacy Geocoding shape to this one, and so
 * unit tests can pin the extraction rules without hitting the network.
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
 * Best-effort reverse-geocode of lat/lng to a "Suburb, City" label
 * via the internal /api/reverse-geocode route. Returns null on any
 * failure — the caller (ChangeLocationSheet) treats null as "fall
 * back to the generic Current location label".
 */
export async function reverseGeocodeSuburb(
  latitude:  number,
  longitude: number,
): Promise<string | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  try {
    const res = await fetch(
      `${REVERSE_GEOCODE_ROUTE}?lat=${encodeURIComponent(latitude)}&lng=${encodeURIComponent(longitude)}`,
      { credentials: 'same-origin' },
    );
    if (!res.ok) {
      // 400 invalid_params, 401 unauthenticated, 429 rate_limited,
      // 5xx — every non-OK degrades to null so the sheet's fallback
      // machinery takes over.
      console.warn('[reverseGeocode] non-2xx from /api/reverse-geocode', { status: res.status });
      return null;
    }
    const data = (await res.json().catch(() => null)) as { label?: string | null } | null;
    return data?.label ?? null;
  } catch (err) {
    console.warn('[reverseGeocode] fetch failed', { message: (err as Error).message });
    return null;
  }
}
