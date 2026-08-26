// ─── Server-side neighbourhood/locality geocoding for bulk import ───────
//
// Bulk-import sources (see quickImportCsv.ts) give a free-text
// neighbourhood string ("Springs, Springs, Gauteng") instead of a full
// street address, so the browser Places Autocomplete + Place Details
// flow (lib/maps/places.ts) doesn't apply — there is no address for a
// human to pick from a dropdown, and this needs to run unattended over
// potentially thousands of rows.
//
// Uses Places API (New) Text Search, server-side, with its OWN
// server-only key (GOOGLE_PLACES_SERVER_KEY — NOT the browser
// NEXT_PUBLIC_GOOGLE_PLACES_KEY, which is HTTP-referrer-restricted and
// would reject a server-to-server call with no Origin/Referer header).
// This module is confined to the allow-list in app/no-geocoding-api.
// test.ts, the same pattern already used for the reverse-geocode
// route's confined use of the legacy Geocoding key.
//
// Text Search only returns a usable lat/lng once you ask for
// `places.location` — that field sits in Text Search's Pro pricing
// tier; there's no Essentials/IDs-only equivalent that includes a
// coordinate (unlike Place Details, where lib/maps/places.ts keeps to
// an Essentials-only field mask). Call volume stays low regardless:
// geocodeLocalities() de-duplicates by normalised query string before
// calling Google, so a batch of thousands of leads only pays for its
// distinct neighbourhoods — typically dozens, not thousands.

const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK       = 'places.location,places.formattedAddress';
const CONCURRENCY      = 5;

export type LocalityCoords = {
  lat:              number;
  lng:              number;
  formattedAddress: string;
};

export function normaliseLocalityQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Look up ONE locality string. Returns null on a missing key, empty
 * input, non-2xx response, or a network/parse failure — callers treat
 * "no coordinates yet" as a normal, recoverable outcome: the lead still
 * imports, it just lands in /crm/map's "missing coordinates" tray for
 * later manual backfill via the real address-autocomplete flow.
 */
export async function geocodeLocality(query: string): Promise<LocalityCoords | null> {
  const apiKey  = process.env.GOOGLE_PLACES_SERVER_KEY;
  const trimmed = query.trim();
  if (!apiKey || !trimmed) return null;

  try {
    const res = await fetch(TEXT_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery:    `${trimmed}, South Africa`,
        regionCode:   'ZA',
        languageCode: 'en',
      }),
    });
    if (!res.ok) {
      console.warn('[localityGeocode] text search non-2xx', { status: res.status });
      return null;
    }
    const data = (await res.json().catch(() => null)) as {
      places?: Array<{
        location?:         { latitude?: number; longitude?: number };
        formattedAddress?: string;
      }>;
    } | null;
    const place = data?.places?.[0];
    if (!place?.location || typeof place.location.latitude !== 'number' || typeof place.location.longitude !== 'number') {
      return null;
    }
    return {
      lat:              place.location.latitude,
      lng:              place.location.longitude,
      formattedAddress: place.formattedAddress ?? '',
    };
  } catch (err) {
    console.warn('[localityGeocode] text search failed', { message: (err as Error).message });
    return null;
  }
}

/**
 * Resolve MANY locality strings with de-duplication: each distinct
 * (normalised) query is sent to Google once, however many rows share
 * it. Runs with a small concurrency cap — one at a time would be
 * painfully serial for a few hundred distinct localities; firing them
 * all at once risks bursting Google's rate limit.
 *
 * Pure Google-only resolver, no cache. Prefer resolveLocalitiesWithCache
 * below for anything that runs more than once (i.e. every real import) —
 * this is exported mainly for that function's own fallback path and for
 * direct testing.
 */
export async function geocodeLocalities(queries: string[]): Promise<Map<string, LocalityCoords | null>> {
  const distinct = Array.from(new Set(queries.map(normaliseLocalityQuery).filter(Boolean)));
  const results  = new Map<string, LocalityCoords | null>();

  let next = 0;
  async function worker() {
    while (next < distinct.length) {
      const query = distinct[next++];
      results.set(query, await geocodeLocality(query));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, distinct.length) }, worker));
  return results;
}

// Intentionally loose, same rationale as lib/practice/tradingGate.ts'
// TradingGateSupabase: lets the caller pass either the SSR session
// client or the service-role client without TypeScript choking on
// Supabase's deeply-generic PostgREST builder types. Only two calls are
// made against it: a SELECT and an UPSERT on crm_locality_geocode_cache
// (see lib/crm/localityGeocode.test.ts for the exact contract).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LocalityGeocodeSupabase = any;

type CacheRow = {
  query_normalised:  string;
  latitude:           number;
  longitude:          number;
  formatted_address:  string | null;
};

/**
 * Resolve MANY locality strings, backed by a PERSISTENT cache
 * (crm_locality_geocode_cache) so a neighbourhood only ever gets sent
 * to Google once, ever — not once per row, and not once per import
 * batch either. Only successful geocodes are cached; a miss is retried
 * on the next call rather than being written off permanently.
 */
export async function resolveLocalitiesWithCache(
  supabase: LocalityGeocodeSupabase,
  queries:  string[],
): Promise<Map<string, LocalityCoords | null>> {
  const distinct = Array.from(new Set(queries.map(normaliseLocalityQuery).filter(Boolean)));
  const results  = new Map<string, LocalityCoords | null>();
  if (distinct.length === 0) return results;

  const { data: cached } = await supabase
    .from('crm_locality_geocode_cache')
    .select('query_normalised, latitude, longitude, formatted_address')
    .in('query_normalised', distinct);

  const cacheHit = new Set<string>();
  for (const row of (cached ?? []) as CacheRow[]) {
    results.set(row.query_normalised, {
      lat:              row.latitude,
      lng:              row.longitude,
      formattedAddress: row.formatted_address ?? '',
    });
    cacheHit.add(row.query_normalised);
  }

  const misses = distinct.filter(q => !cacheHit.has(q));
  if (misses.length === 0) return results;

  const fresh = await geocodeLocalities(misses);
  const toCache: CacheRow[] = [];
  for (const [query, coords] of fresh) {
    results.set(query, coords);
    if (coords) {
      toCache.push({
        query_normalised:  query,
        latitude:           coords.lat,
        longitude:          coords.lng,
        formatted_address:  coords.formattedAddress || null,
      });
    }
  }

  if (toCache.length > 0) {
    // ignoreDuplicates: a concurrent import resolving the same NEW
    // locality at the same time would otherwise 23505 on the unique
    // constraint — a lost race here just means we skip re-caching a
    // row that's already there, not a failed import.
    const { error } = await supabase
      .from('crm_locality_geocode_cache')
      .upsert(toCache, { onConflict: 'query_normalised', ignoreDuplicates: true });
    if (error) console.warn('[localityGeocode] cache upsert failed', { message: error.message });
  }

  return results;
}
