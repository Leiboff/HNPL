import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  geocodeAddress,
  isWithinSouthAfrica,
  SA_BOUNDS,
  GOOGLE_GEOCODE_TIMEOUT_MS,
} from './geocode';

// ─── Tests for the Google Geocoding wrapper ─────────────────────────────
//
// Same discipline as the SMS/Email senders:
//   • Never throws — every failure mode returns { ok:false, reason }.
//   • Bounded — 6s AbortController timeout, surfaces as reason:'timeout'.
//   • Server-only — the API key is read from process.env at call time
//     (not at import time) so a missing key doesn't crash the build.

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = 'TEST_KEY';
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.GOOGLE_MAPS_API_KEY;
});

describe('geocodeAddress — happy path', () => {
  it('returns lat/long + formatted address from the top result', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status:  'OK',
        results: [{
          geometry: { location: { lat: -26.107567, lng: 28.056456 } },
          formatted_address: '1 Sandton Drive, Sandhurst, Sandton, 2196, South Africa',
        }],
      }),
    });

    const r = await geocodeAddress('1 Sandton Drive, Sandton');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.latitude).toBeCloseTo(-26.107567, 5);
    expect(r.longitude).toBeCloseTo(28.056456, 5);
    expect(r.formatted).toMatch(/Sandton/);
  });

  it('hints at South Africa via region=za in the request URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'OK', results: [{ geometry: { location: { lat: -26, lng: 28 } } }] }),
    });
    global.fetch = fetchSpy;

    await geocodeAddress('Rosebank');
    const url = (fetchSpy.mock.calls[0] as [string])[0];
    expect(url).toContain('region=za');
    expect(url).toContain('key=TEST_KEY');
  });
});

describe('geocodeAddress — failure modes never throw', () => {
  it('returns not_configured when GOOGLE_MAPS_API_KEY is missing', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const r = await geocodeAddress('anywhere');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_configured');
  });

  it('returns no_results on an empty query (no fetch fired)', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const r = await geocodeAddress('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_results');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns no_results when Google reports ZERO_RESULTS', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ZERO_RESULTS', results: [] }),
    });
    const r = await geocodeAddress('Atlantis');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_results');
  });

  it('returns provider_error when Google returns non-2xx', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const r = await geocodeAddress('anywhere');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('provider_error');
  });

  it('returns provider_error on a non-OK status field', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'OVER_QUERY_LIMIT', results: [] }),
    });
    const r = await geocodeAddress('anywhere');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('provider_error');
  });

  it('returns network on a thrown fetch (not an abort)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const r = await geocodeAddress('anywhere');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('network');
  });

  it('returns timeout when fetch is aborted (the bounded-fetch guarantee)', async () => {
    global.fetch = vi.fn().mockImplementation(() => {
      const err = new Error('aborted') as Error & { name: string };
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const r = await geocodeAddress('anywhere');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
  });
});

describe('GOOGLE_GEOCODE_TIMEOUT_MS — sanity', () => {
  it('is set to a server-safe 6 seconds (matches the email/sms sender ceiling)', () => {
    expect(GOOGLE_GEOCODE_TIMEOUT_MS).toBe(6_000);
  });
});

// ─── isWithinSouthAfrica — SA bounding-box validation ──────────────────

describe('isWithinSouthAfrica', () => {
  it('accepts Johannesburg (Sandton CBD)', () => {
    expect(isWithinSouthAfrica(-26.107567, 28.056456)).toBe(true);
  });

  it('accepts Cape Town (waterfront)', () => {
    expect(isWithinSouthAfrica(-33.918861, 18.4233)).toBe(true);
  });

  it('accepts the four corners of the bounding box', () => {
    expect(isWithinSouthAfrica(SA_BOUNDS.latMin, SA_BOUNDS.lngMin)).toBe(true);
    expect(isWithinSouthAfrica(SA_BOUNDS.latMax, SA_BOUNDS.lngMax)).toBe(true);
  });

  it('rejects a positive latitude (transposed sign — would be in the Arabian Sea)', () => {
    expect(isWithinSouthAfrica(26.107567, 28.056456)).toBe(false);
  });

  it('rejects a US-style longitude (would be in the Pacific)', () => {
    expect(isWithinSouthAfrica(-26.107567, -122.4194)).toBe(false);
  });

  it('rejects coordinates just outside the bounding box', () => {
    expect(isWithinSouthAfrica(-21.999, 28)).toBe(false);  // too far north
    expect(isWithinSouthAfrica(-36, 28)).toBe(false);      // too far south
    expect(isWithinSouthAfrica(-26, 15.999)).toBe(false);  // too far west
    expect(isWithinSouthAfrica(-26, 33.001)).toBe(false);  // too far east
  });
});
