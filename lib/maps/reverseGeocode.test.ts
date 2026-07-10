import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractSuburbLabel, reverseGeocodeSuburb } from './reverseGeocode';

// ─── Tests — reverse-geocode client wrapper + shared extractor ─────────
//
// The Google call itself lives in the server route
// (app/api/reverse-geocode/route.ts) — this file only tests the
// browser-side wrapper's contract:
//   • Passes coords to the internal route via query params.
//   • Reads `label` off the JSON response.
//   • Never throws — every failure path returns null so the sheet's
//     'Current location' fallback takes over.
//
// The pure `extractSuburbLabel` is unit-tested against Places-New
// addressComponent shape. The route normalizes legacy Geocoding shape
// (long_name / short_name) → Places-New shape (longText / shortText)
// before calling this helper, so it only ever sees one shape.

describe('extractSuburbLabel — pure address-component extraction', () => {
  it('combines sublocality + locality into "Suburb, City"', () => {
    const label = extractSuburbLabel([
      { longText: 'Glenhazel',    shortText: 'Glenhazel',    types: ['sublocality', 'sublocality_level_1', 'political'] },
      { longText: 'Johannesburg', shortText: 'Johannesburg', types: ['locality', 'political'] },
      { longText: 'ZA',           shortText: 'ZA',           types: ['country'] },
    ]);
    expect(label).toBe('Glenhazel, Johannesburg');
  });

  it('falls back to neighborhood when no sublocality is present', () => {
    const label = extractSuburbLabel([
      { longText: 'Braamfontein', shortText: 'Braamfontein', types: ['neighborhood', 'political'] },
      { longText: 'Johannesburg', shortText: 'Johannesburg', types: ['locality',     'political'] },
    ]);
    expect(label).toBe('Braamfontein, Johannesburg');
  });

  it('handles sublocality_level_2 when level_1 is absent', () => {
    const label = extractSuburbLabel([
      { longText: 'Rivonia',   shortText: 'Rivonia',   types: ['sublocality', 'sublocality_level_2'] },
      { longText: 'Sandton',   shortText: 'Sandton',   types: ['locality',    'political'] },
    ]);
    expect(label).toBe('Rivonia, Sandton');
  });

  it('returns just the city when there is no suburb component', () => {
    const label = extractSuburbLabel([
      { longText: 'Cape Town', shortText: 'Cape Town', types: ['locality', 'political'] },
      { longText: 'ZA',        shortText: 'ZA',        types: ['country'] },
    ]);
    expect(label).toBe('Cape Town');
  });

  it('returns null when neither suburb NOR city is present (no useful label)', () => {
    const label = extractSuburbLabel([
      { longText: 'Gauteng', shortText: 'GP', types: ['administrative_area_level_1'] },
      { longText: 'ZA',      shortText: 'ZA', types: ['country'] },
    ]);
    expect(label).toBeNull();
  });

  it('returns null for an empty component list', () => {
    expect(extractSuburbLabel([])).toBeNull();
  });

  it('picks the FIRST matching component of each type (Google order is address-hierarchy order)', () => {
    // Google occasionally returns multiple sublocalities (e.g. nested
    // level_1 + level_2) — the first is the more-specific one for our
    // purposes. Locality is usually only present once.
    const label = extractSuburbLabel([
      { longText: 'First Suburb',  shortText: 'FS', types: ['sublocality'] },
      { longText: 'Second Suburb', shortText: 'SS', types: ['sublocality'] },
      { longText: 'City',          shortText: 'C',  types: ['locality'] },
    ]);
    expect(label).toBe('First Suburb, City');
  });
});

// ─── reverseGeocodeSuburb — HTTP wrapper over the internal route ──────

describe('reverseGeocodeSuburb — talks to /api/reverse-geocode', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns null when lat or lng is not finite (no fetch call)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await reverseGeocodeSuburb(NaN, 28.05)).toBeNull();
    expect(await reverseGeocodeSuburb(-26.10, Infinity)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GETs /api/reverse-geocode with lat/lng in the query string', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ label: 'Glenhazel, Johannesburg' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const label = await reverseGeocodeSuburb(-26.10, 28.05);
    expect(label).toBe('Glenhazel, Johannesburg');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/api/reverse-geocode');
    expect(String(url)).toContain('lat=-26.1');
    expect(String(url)).toContain('lng=28.05');
  });

  it('returns null when the route responds with non-2xx (401 / 429 / 5xx all degrade the same way)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 429 }));
    expect(await reverseGeocodeSuburb(-26.10, 28.05)).toBeNull();
    warn.mockRestore();
  });

  it('returns null when the route responds with { label: null }', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ label: null }), { status: 200 }),
    );
    expect(await reverseGeocodeSuburb(-26.10, 28.05)).toBeNull();
  });

  it('never throws when fetch itself rejects — returns null instead', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    expect(await reverseGeocodeSuburb(-26.10, 28.05)).toBeNull();
    warn.mockRestore();
  });

  it('does NOT contact Google directly (never any maps.googleapis.com URL from the browser)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ label: 'Whatever' }), { status: 200 }),
    );
    await reverseGeocodeSuburb(-26.10, 28.05);
    for (const [url] of fetchSpy.mock.calls) {
      expect(String(url)).not.toContain('maps.googleapis.com');
      expect(String(url)).not.toContain('places.googleapis.com');
    }
  });
});
