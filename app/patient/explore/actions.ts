'use server';

import { geocodeAddress } from '@/lib/maps/geocode';

// ─── Server action: geocode a typed suburb/location ────────────────────
//
// Patient-facing fallback for the explore page when browser geolocation
// is denied / unavailable. The patient types a suburb name (e.g.
// "Rosebank"); we resolve to lat/long server-side so the Google API
// key never reaches the browser.
//
// POPIA: the returned coordinates are sent back to the client for the
// in-session sort/filter only. **The user's location is NEVER persisted
// to the database** — not against their profile, not in any side table.
// The patient surface holds it in component state for the session.

export type SuburbGeocodeResult =
  | { ok: true;  latitude: number; longitude: number; formatted: string }
  | { ok: false; reason: 'empty' | 'not_configured' | 'no_results' | 'timeout' | 'network' | 'provider_error' };

export async function geocodeSuburb(query: string): Promise<SuburbGeocodeResult> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  // Append ", South Africa" to bias Google to the SA result even more
  // strongly than the region:'za' hint alone (helps with ambiguous
  // suburb names that exist worldwide).
  const result = await geocodeAddress(`${trimmed}, South Africa`);
  if (!result.ok) return { ok: false, reason: result.reason };

  return {
    ok:        true,
    latitude:  result.latitude,
    longitude: result.longitude,
    formatted: result.formatted,
  };
}
