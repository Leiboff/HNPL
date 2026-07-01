import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractSuburbLabel, reverseGeocodeSuburb } from './reverseGeocode';

// ─── Tests — reverse-geocode helper (display-only suburb label) ────────
//
// The pure `extractSuburbLabel` is unit-tested directly against
// Places address-components. The IO wrapper `reverseGeocodeSuburb`
// is tested against a mocked fetch — HTTP shape, field-mask +
// endpoint, and the always-graceful fallback contract (never throws;
// returns null on any failure).

// ─── extractSuburbLabel ────────────────────────────────────────────────

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

// ─── reverseGeocodeSuburb — HTTP wrapper w/ mocked fetch ───────────────

describe('reverseGeocodeSuburb — HTTP wrapper + graceful fallback', () => {
  const OLD_ENV = process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY = 'test-key';
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY = OLD_ENV;
    vi.restoreAllMocks();
  });

  it('returns null when the API key is missing (no fetch call)', async () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await reverseGeocodeSuburb(-26.10, 28.05);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when lat or lng is not finite', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await reverseGeocodeSuburb(NaN, 28.05)).toBeNull();
    expect(await reverseGeocodeSuburb(-26.10, Infinity)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to places:searchNearby with the correct headers + body shape', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        places: [{
          addressComponents: [
            { longText: 'Glenhazel',    shortText: 'Glenhazel',    types: ['sublocality'] },
            { longText: 'Johannesburg', shortText: 'Johannesburg', types: ['locality']    },
          ],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const label = await reverseGeocodeSuburb(-26.10, 28.05);
    expect(label).toBe('Glenhazel, Johannesburg');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://places.googleapis.com/v1/places:searchNearby');
    expect(init?.method).toBe('POST');
    // Essentials-only field mask; sublocality lookup only.
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('test-key');
    expect(headers['X-Goog-FieldMask']).toBe('places.addressComponents,places.formattedAddress');
    // Body contains a searchNearby-shaped payload.
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.locationRestriction.circle.center).toEqual({ latitude: -26.10, longitude: 28.05 });
    expect(body.locationRestriction.circle.radius).toBe(500);
    expect(body.maxResultCount).toBe(1);
  });

  it('returns null when the response is non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 403 }),
    );
    expect(await reverseGeocodeSuburb(-26.10, 28.05)).toBeNull();
  });

  it('returns null when the response has no places', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ places: [] }), { status: 200 }),
    );
    expect(await reverseGeocodeSuburb(-26.10, 28.05)).toBeNull();
  });

  it('never throws when fetch itself rejects — returns null instead', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    expect(await reverseGeocodeSuburb(-26.10, 28.05)).toBeNull();
  });

  it('returns null when address components lack sublocality AND locality', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        places: [{
          addressComponents: [
            { longText: 'ZA', shortText: 'ZA', types: ['country'] },
          ],
        }],
      }), { status: 200 }),
    );
    expect(await reverseGeocodeSuburb(-26.10, 28.05)).toBeNull();
  });
});
