import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Route-handler tests — /api/reverse-geocode ────────────────────────
//
// Owned surface:
//   • Auth (401 for anon).
//   • Input validation (400 for non-finite / out-of-bounds coords).
//   • Rate limiting (429 after N calls per window per user).
//   • Server key gating (missing key → { label: null } + warn).
//   • Geocoding API integration (fixture-tested): OK path parses
//     legacy shape into a "Suburb, City" label; ZERO_RESULTS + other
//     non-OK statuses degrade to { label: null }.
//   • Adapter: extractSuburbLabel is called with the legacy shape
//     normalized to Places-New shape (longText / shortText / types).

// Supabase client mock: each test toggles whether a session exists via
// `sessionUser`. The GET handler reads `data.user`.
let sessionUser: { id: string } | null = null;
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: sessionUser }, error: null }),
    },
  }),
}));

import { GET, __resetRateBucketsForTests } from './route';

const OLD_ENV = process.env.GOOGLE_GEOCODING_SERVER_KEY;

beforeEach(() => {
  sessionUser = { id: 'user-abc' };
  process.env.GOOGLE_GEOCODING_SERVER_KEY = 'server-test-key';
  __resetRateBucketsForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env.GOOGLE_GEOCODING_SERVER_KEY = OLD_ENV;
  vi.restoreAllMocks();
});

function makeReq(url: string): NextRequest {
  return new NextRequest(url);
}

function reverseGeocodeReq(lat: string | number, lng: string | number): NextRequest {
  return makeReq(`http://test/api/reverse-geocode?lat=${lat}&lng=${lng}`);
}

// Realistic SA fixture with sublocality (Glenhazel) + locality (JHB).
// Legacy Geocoding shape — long_name / short_name / types.
const OK_FIXTURE_GLENHAZEL = {
  status: 'OK',
  results: [
    {
      address_components: [
        { long_name: '12 Sanders Rd',  short_name: '12',           types: ['street_address'] },
        { long_name: 'Glenhazel',      short_name: 'Glenhazel',    types: ['sublocality', 'sublocality_level_1', 'political'] },
        { long_name: 'Johannesburg',   short_name: 'JHB',          types: ['locality', 'political'] },
        { long_name: 'Gauteng',        short_name: 'GP',           types: ['administrative_area_level_1', 'political'] },
        { long_name: 'South Africa',   short_name: 'ZA',           types: ['country', 'political'] },
      ],
      formatted_address: '12 Sanders Rd, Glenhazel, Johannesburg, 2192, South Africa',
    },
  ],
};

// ─── Auth ──────────────────────────────────────────────────────────────

describe('GET /api/reverse-geocode — auth', () => {
  it('returns 401 when no session', async () => {
    sessionUser = null;
    const res = await GET(reverseGeocodeReq('-26.10', '28.05'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });
});

// ─── Input validation ─────────────────────────────────────────────────

describe('GET /api/reverse-geocode — input validation', () => {
  it('returns 400 when lat is missing', async () => {
    const res = await GET(makeReq('http://test/api/reverse-geocode?lng=28.05'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when coords are non-numeric', async () => {
    const res = await GET(makeReq('http://test/api/reverse-geocode?lat=abc&lng=xyz'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when lat is out of bounds', async () => {
    const res = await GET(reverseGeocodeReq('91', '28.05'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when lng is out of bounds', async () => {
    const res = await GET(reverseGeocodeReq('-26', '181'));
    expect(res.status).toBe(400);
  });
});

// ─── Missing key ──────────────────────────────────────────────────────

describe('GET /api/reverse-geocode — server key gating', () => {
  it('returns { label: null } (with console.warn) when GOOGLE_GEOCODING_SERVER_KEY is unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.GOOGLE_GEOCODING_SERVER_KEY;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await GET(reverseGeocodeReq('-26.10', '28.05'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─── Happy path ───────────────────────────────────────────────────────

describe('GET /api/reverse-geocode — Google integration', () => {
  it('OK response with sublocality + locality → "Suburb, City" label', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(OK_FIXTURE_GLENHAZEL), { status: 200 }),
    );
    const res = await GET(reverseGeocodeReq('-26.10', '28.05'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: 'Glenhazel, Johannesburg' });

    // Google was called with the legacy Geocoding endpoint (server-
    // side, referrer restriction doesn't apply here) and the server-
    // only key — never the browser Places key.
    const [url] = fetchSpy.mock.calls[0]!;
    const urlStr = String(url);
    expect(urlStr).toContain('https://maps.googleapis.com/maps/api/geocode/json');
    // encodeURIComponent leaves the literal comma alone; Google
    // accepts both raw comma and %2C. Match on the coord values,
    // not on the exact encoding.
    expect(urlStr).toMatch(/latlng=-26\.1(?:%2C|,)28\.05/);
    expect(urlStr).toContain('key=server-test-key');
  });

  it('ZERO_RESULTS → { label: null } (expected in remote areas, no warn)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }), { status: 200 }),
    );
    const res = await GET(reverseGeocodeReq('-89', '0'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: null });
    // ZERO_RESULTS is a valid geocode outcome — don't spam the log.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('Google non-OK status (REQUEST_DENIED) → { label: null } with a warn for ops', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'REQUEST_DENIED', error_message: 'API key not authorised' }), { status: 200 }),
    );
    const res = await GET(reverseGeocodeReq('-26.10', '28.05'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('non-2xx HTTP → { label: null }', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const res = await GET(reverseGeocodeReq('-26.10', '28.05'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: null });
    warn.mockRestore();
  });

  it('fetch rejects → { label: null } (never a 500)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const res = await GET(reverseGeocodeReq('-26.10', '28.05'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: null });
    warn.mockRestore();
  });
});

// ─── Component-shape adaptation (legacy → Places-New) ─────────────────

describe('GET /api/reverse-geocode — legacy → Places-New shape adapter', () => {
  it('extracts the label even when the address_components use long_name/short_name (not longText/shortText)', async () => {
    // The whole point of the adapter — the Geocoding API returns
    // long_name; extractSuburbLabel reads longText; the route must
    // bridge the two so the extractor sees the fields it expects.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(OK_FIXTURE_GLENHAZEL), { status: 200 }),
    );
    const res = await GET(reverseGeocodeReq('-26.10', '28.05'));
    expect(await res.json()).toEqual({ label: 'Glenhazel, Johannesburg' });
  });

  it('handles a component array where only city is present (no sublocality)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        status: 'OK',
        results: [{
          address_components: [
            { long_name: 'Cape Town',    short_name: 'Cape Town', types: ['locality', 'political'] },
            { long_name: 'South Africa', short_name: 'ZA',        types: ['country', 'political'] },
          ],
        }],
      }), { status: 200 }),
    );
    const res = await GET(reverseGeocodeReq('-33.9', '18.4'));
    expect(await res.json()).toEqual({ label: 'Cape Town' });
  });

  it('returns { label: null } when no useful component (no suburb AND no city)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        status: 'OK',
        results: [{
          address_components: [
            { long_name: 'Gauteng',      short_name: 'GP', types: ['administrative_area_level_1'] },
            { long_name: 'South Africa', short_name: 'ZA', types: ['country'] },
          ],
        }],
      }), { status: 200 }),
    );
    const res = await GET(reverseGeocodeReq('-26', '28'));
    expect(await res.json()).toEqual({ label: null });
  });
});

// ─── Rate limiting ─────────────────────────────────────────────────────

describe('GET /api/reverse-geocode — rate limit', () => {
  it('returns 429 after 30 requests within the 5-minute window (per user)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(OK_FIXTURE_GLENHAZEL), { status: 200 }),
    );
    // 30 permitted
    for (let i = 0; i < 30; i++) {
      const r = await GET(reverseGeocodeReq('-26.10', '28.05'));
      expect(r.status).toBe(200);
    }
    // 31st is throttled
    const r31 = await GET(reverseGeocodeReq('-26.10', '28.05'));
    expect(r31.status).toBe(429);
    expect(await r31.json()).toEqual({ error: 'rate_limited' });
  });

  it('rate limits are per-user (a different user has their own bucket)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(OK_FIXTURE_GLENHAZEL), { status: 200 }),
    );
    for (let i = 0; i < 30; i++) {
      await GET(reverseGeocodeReq('-26.10', '28.05'));
    }
    // user-abc exhausted
    expect((await GET(reverseGeocodeReq('-26.10', '28.05'))).status).toBe(429);
    // switch to a new user — clean bucket
    sessionUser = { id: 'user-def' };
    expect((await GET(reverseGeocodeReq('-26.10', '28.05'))).status).toBe(200);
  });
});
