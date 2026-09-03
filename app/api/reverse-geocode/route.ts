import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { extractSuburbLabel } from '@/lib/maps/reverseGeocode';
import { clientIp, consumeAll, RATE_LIMITS } from '@/lib/security/rateLimit';

export const runtime = 'nodejs';

// ─── Reverse-geocode route ─────────────────────────────────────────────
//
// Server-side wrapper around the legacy Geocoding REST API. Exists
// because:
//   • The browser autocomplete keeps working on the HTTP-referrer-
//     restricted NEXT_PUBLIC_GOOGLE_PLACES_KEY (Places API New accepts
//     referrer keys).
//   • The Geocoding web service REJECTS referrer-restricted keys —
//     any browser call to maps.googleapis.com/maps/api/geocode with a
//     referrer key 403s in production. So this route uses a separate
//     server-only key: GOOGLE_GEOCODING_SERVER_KEY.
//   • Places (New) SearchNearby (the previous reverse-geocode path)
//     returns nothing in POI-sparse suburbs — most residential SA.
//     The Geocoding API returns address components for ANY coord.
//
// The route is auth-gated and uses the shared Postgres limiter, keyed by
// both account and IP. This is billable server-side traffic: a process-local
// Map is not an abuse control on a horizontally scaling serverless runtime.
//
// Contract with the client:
//   • 200 { label: string | null }
//       label is the "Suburb, City" display string, or null when the
//       geocode returned nothing usable. NEVER 500 for a geocode
//       miss — the sheet's fallback machinery ("Current location")
//       handles null cleanly. Config / upstream failures also fall
//       through as { label: null } with a server-side console.warn.
//   • 400 { error: 'invalid_params' } — lat/lng not finite / out of
//         bounds. Client shouldn't send these; if it does, the sheet
//         fallback still catches the null.
//   • 401 { error: 'unauthenticated' } — no session.
//   • 429 { error: 'rate_limited' } — per-user quota exceeded.

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

const GOOGLE_TIMEOUT_MS = 5_000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const latStr = req.nextUrl.searchParams.get('lat');
  const lngStr = req.nextUrl.searchParams.get('lng');
  const lat = latStr != null ? Number(latStr) : NaN;
  const lng = lngStr != null ? Number(lngStr) : NaN;
  if (
    !Number.isFinite(lat) || !Number.isFinite(lng)
    || lat < -90 || lat > 90 || lng < -180 || lng > 180
  ) {
    return NextResponse.json({ error: 'invalid_params' }, { status: 400 });
  }

  if (!await consumeAll('reverse_geocode', [
    [await clientIp(), RATE_LIMITS.reverse_geocode.ip],
    [user.id,           RATE_LIMITS.reverse_geocode.account!],
  ])) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const apiKey = process.env.GOOGLE_GEOCODING_SERVER_KEY;
  if (!apiKey) {
    console.warn('[reverse-geocode] GOOGLE_GEOCODING_SERVER_KEY not configured — returning null');
    return NextResponse.json({ label: null });
  }

  const url = `${GEOCODE_URL}?latlng=${encodeURIComponent(lat)},${encodeURIComponent(lng)}&key=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn('[reverse-geocode] non-2xx from Geocoding API', { status: res.status });
      return NextResponse.json({ label: null });
    }
    const data = (await res.json().catch(() => null)) as {
      status?: string;
      results?: Array<{
        address_components?: Array<{
          long_name?:  string;
          short_name?: string;
          types?:      string[];
        }>;
      }>;
    } | null;

    if (!data || data.status !== 'OK') {
      // ZERO_RESULTS is expected in the sea (or remote areas) — don't
      // spam the log. The other statuses are worth surfacing.
      if (data?.status && data.status !== 'ZERO_RESULTS') {
        console.warn('[reverse-geocode] non-OK status from Geocoding API', { status: data.status });
      }
      return NextResponse.json({ label: null });
    }

    const first = data.results?.[0];
    if (!first?.address_components) return NextResponse.json({ label: null });

    // Adapt legacy shape (long_name/short_name) → the Places-New
    // shape (longText/shortText) that extractSuburbLabel already
    // understands. `types` is identical across both APIs.
    const adapted = first.address_components.map((c) => ({
      longText:  c.long_name  ?? '',
      shortText: c.short_name ?? '',
      types:     c.types      ?? [],
    }));
    const label = extractSuburbLabel(adapted);
    return NextResponse.json({ label });
  } catch (err) {
    console.warn('[reverse-geocode] fetch failed', { message: (err as Error).message });
    return NextResponse.json({ label: null });
  }
}
