// ─── Google Geocoding — server-side only, bounded, never throws ────────
//
// Resolves a street-address-ish query into lat/long via Google's
// Geocoding API. Same discipline as lib/email/resend + lib/sms/smsportal:
//
//   • 6 s AbortController timeout — a slow Google must NEVER hang the
//     surrounding server action. After 6 s we give up and return a
//     clean failure to the caller.
//   • try/catch wrapping the whole fetch + JSON path so a network
//     failure or malformed response is a { ok:false, reason } not a
//     throw up the call stack.
//   • Server-only: the API key lives in process.env.GOOGLE_MAPS_API_KEY
//     (NOT NEXT_PUBLIC_) so it never reaches the browser. Importing
//     this file from a Client Component would surface the key via the
//     server bundle, but TypeScript can't catch that — discipline at
//     the call site is the actual guard.
//   • No-op + warn-once when the key isn't set (dev environments
//     without creds don't crash; they just return ok:false).
//
// Bias to SA: a `region: 'za'` hint biases ambiguous queries toward
// South Africa. Two-letter ccTLD. Doesn't restrict — it just nudges.

export type GeocodeResult =
  | { ok: true;  latitude: number; longitude: number; formatted: string }
  | { ok: false; reason: 'not_configured' | 'no_results' | 'timeout' | 'network' | 'provider_error' };

export const GOOGLE_GEOCODE_TIMEOUT_MS = 6_000;
const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

let warnedMissingKey = false;

/**
 * Geocode a free-text address (or any place query, e.g. a suburb name)
 * to a single lat/long. Returns the first ('best') result Google ranks.
 * Falls back to `{ ok: false }` on any failure — caller must handle.
 *
 * @param query e.g. "1 Sandton Drive, Sandton, Johannesburg" or just "Rosebank".
 */
export async function geocodeAddress(query: string): Promise<GeocodeResult> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, reason: 'no_results' };

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(
        '[geocode] GOOGLE_MAPS_API_KEY missing — geocoding is a documented no-op. ' +
        'Set the env var server-side to enable.',
      );
    }
    return { ok: false, reason: 'not_configured' };
  }

  const url = new URL(GOOGLE_GEOCODE_URL);
  url.searchParams.set('address', trimmed);
  url.searchParams.set('region', 'za');
  url.searchParams.set('key', apiKey);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), GOOGLE_GEOCODE_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method:  'GET',
      headers: { 'Accept': 'application/json' },
      signal:  controller.signal,
    });
    if (!res.ok) {
      console.warn('[geocode] Google non-2xx', { status: res.status });
      return { ok: false, reason: 'provider_error' };
    }

    const data = (await res.json().catch(() => null)) as {
      status?: string;
      results?: Array<{
        geometry?: { location?: { lat?: number; lng?: number } };
        formatted_address?: string;
      }>;
    } | null;

    if (!data) {
      return { ok: false, reason: 'no_results' };
    }
    // Order matters: ZERO_RESULTS is the legitimate "no match" answer.
    // Any other non-OK status (OVER_QUERY_LIMIT, REQUEST_DENIED,
    // INVALID_REQUEST, UNKNOWN_ERROR) is a provider problem and must
    // surface distinctly from "we couldn't find the address."
    if (data.status === 'ZERO_RESULTS') {
      return { ok: false, reason: 'no_results' };
    }
    if (data.status !== 'OK') {
      console.warn('[geocode] Google non-OK status', { status: data.status });
      return { ok: false, reason: 'provider_error' };
    }
    if (!data.results?.length) {
      return { ok: false, reason: 'no_results' };
    }

    const top = data.results[0];
    const lat = top?.geometry?.location?.lat;
    const lng = top?.geometry?.location?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return { ok: false, reason: 'no_results' };
    }

    return {
      ok:        true,
      latitude:  lat,
      longitude: lng,
      formatted: top.formatted_address ?? trimmed,
    };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      console.warn('[geocode] timeout');
      return { ok: false, reason: 'timeout' };
    }
    console.warn('[geocode] fetch failed', { message: (err as Error).message });
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── SA coordinate range validation ───────────────────────────────────
//
// South Africa's mainland bounding box is roughly:
//   latitude  ∈ [-35, -22]   (south latitudes — note the sign)
//   longitude ∈ [16, 33]     (east longitudes)
//
// A manual coord-entry that falls outside this range is almost certainly
// a transposed/wrong-sign typo (e.g. positive latitude puts the practice
// in the Arabian Sea). Rejecting at the action layer surfaces the typo
// to the admin instead of pinning the practice in the ocean.

export const SA_BOUNDS = {
  latMin: -35,
  latMax: -22,
  lngMin:  16,
  lngMax:  33,
} as const;

export function isWithinSouthAfrica(latitude: number, longitude: number): boolean {
  return (
    latitude  >= SA_BOUNDS.latMin && latitude  <= SA_BOUNDS.latMax &&
    longitude >= SA_BOUNDS.lngMin && longitude <= SA_BOUNDS.lngMax
  );
}
