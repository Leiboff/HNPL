// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  autocompletePlaces,
  fetchPlaceDetails,
  newSessionToken,
  parseAddressComponents,
  pluckComponent,
} from './places';

// ─── Tests for the Places (New) client wrapper ──────────────────────────
//
// What these pin:
//   • Autocomplete request goes to the v1 endpoint, POSTs the body,
//     carries X-Goog-Api-Key, includes ZA region restriction +
//     sessionToken + (optional) includedPrimaryTypes.
//   • Place Details request hits the v1 endpoint with the sessionToken
//     as a query param, X-Goog-Api-Key + X-Goog-FieldMask headers, and
//     the field mask is Essentials-only (no Pro/Atmosphere fields).
//   • Missing key / network failure return safely (empty / null),
//     never throw.
//   • newSessionToken returns a UUID v4 (cost-correctness anchor).
//   • parseAddressComponents extracts suburb/city/province/postal from
//     a Place Details addressComponents array.

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY = 'TEST_PLACES_KEY';
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY;
});

describe('autocompletePlaces — request shape', () => {
  it('POSTs to the Places (New) Autocomplete endpoint with the right headers + body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    });
    global.fetch = fetchSpy;

    await autocompletePlaces('1 Sandton', 'token-abc');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('TEST_PLACES_KEY');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body.input).toBe('1 Sandton');
    expect(body.sessionToken).toBe('token-abc');
    expect(body.includedRegionCodes).toEqual(['za']);
  });

  it('forwards includedPrimaryTypes when supplied (locality bias)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ suggestions: [] }) });
    global.fetch = fetchSpy;

    await autocompletePlaces('Rosebank', 'token-1', { includedPrimaryTypes: ['locality', 'sublocality'] });
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.includedPrimaryTypes).toEqual(['locality', 'sublocality']);
  });

  it('omits includedPrimaryTypes when empty (address-bias = Google default)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ suggestions: [] }) });
    global.fetch = fetchSpy;

    await autocompletePlaces('1 Sandton', 'token-1');
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.includedPrimaryTypes).toBeUndefined();
  });

  it('maps suggestion structuredFormat → primary/secondaryText', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        suggestions: [{
          placePrediction: {
            placeId: 'place-1',
            structuredFormat: {
              mainText:      { text: '1 Sandton Drive' },
              secondaryText: { text: 'Sandhurst, Sandton, 2196, South Africa' },
            },
          },
        }],
      }),
    });
    const out = await autocompletePlaces('1 Sandton', 'token-1');
    expect(out).toEqual([{
      placeId:       'place-1',
      primaryText:   '1 Sandton Drive',
      secondaryText: 'Sandhurst, Sandton, 2196, South Africa',
    }]);
  });
});

describe('autocompletePlaces — failure modes never throw', () => {
  it('returns [] when the key is missing (no fetch attempted)', async () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const r = await autocompletePlaces('anything', 'token-1');
    expect(r).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] on empty input (no fetch attempted)', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const r = await autocompletePlaces('   ', 'token-1');
    expect(r).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] on non-2xx', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const r = await autocompletePlaces('Sandton', 'token-1');
    expect(r).toEqual([]);
  });

  it('returns [] on network error (does NOT throw)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(autocompletePlaces('Sandton', 'token-1')).resolves.toEqual([]);
  });
});

describe('fetchPlaceDetails — request shape + field mask + sessionToken', () => {
  it('GETs /v1/places/{placeId}?sessionToken=... with the right headers + Essentials field mask', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id:               'place-1',
        formattedAddress: '1 Sandton Drive, Sandhurst, Sandton, 2196, South Africa',
        location:         { latitude: -26.107567, longitude: 28.056456 },
        addressComponents: [],
      }),
    });
    global.fetch = fetchSpy;

    await fetchPlaceDetails('place-1', 'token-abc');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places/place-1?sessionToken=token-abc');
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('TEST_PLACES_KEY');
    // Essentials-only mask: id + location + formattedAddress + addressComponents.
    // Pro/Atmosphere fields (reviews, photos, openingHours, rating)
    // MUST NOT appear here or we'd be billing on the wrong SKU.
    expect(headers['X-Goog-FieldMask']).toBe('id,location,formattedAddress,addressComponents');
    expect(headers['X-Goog-FieldMask']).not.toMatch(/review|photo|opening|rating/i);
  });

  it('returns the parsed PlaceDetails on a successful response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id:               'place-1',
        formattedAddress: 'Sandton, SA',
        location:         { latitude: -26.1, longitude: 28.05 },
        addressComponents: [
          { longText: 'Sandton', shortText: 'Sandton', types: ['locality', 'political'] },
        ],
      }),
    });
    const r = await fetchPlaceDetails('place-1', 'token-1');
    expect(r).not.toBeNull();
    expect(r!.latitude).toBeCloseTo(-26.1, 5);
    expect(r!.longitude).toBeCloseTo(28.05, 5);
    expect(r!.addressComponents).toHaveLength(1);
  });

  it('returns null when location is missing or malformed', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'place-1', formattedAddress: 'X', /* no location */ }),
    });
    const r = await fetchPlaceDetails('place-1', 'token-1');
    expect(r).toBeNull();
  });

  it('returns null on non-2xx (does NOT throw)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const r = await fetchPlaceDetails('place-1', 'token-1');
    expect(r).toBeNull();
  });

  it('returns null when the key is missing', async () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const r = await fetchPlaceDetails('place-1', 'token-1');
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('newSessionToken — cost-correctness anchor', () => {
  it('returns a UUID v4 string', () => {
    const t = newSessionToken();
    // Standard UUID v4 shape: 8-4-4-4-12 hex with the '4' nibble.
    expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('mints a unique token each call (so a fresh session can be started after each Place Details fetch)', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).not.toBe(b);
  });
});

// ─── parseAddressComponents — best-effort structured extraction ─────────

describe('parseAddressComponents', () => {
  it('plucks suburb (sublocality_level_1), city (locality), province (admin_area_1), postal_code', () => {
    const components = [
      { longText: '1',                    shortText: '1',   types: ['street_number'] },
      { longText: 'Sandton Drive',        shortText: 'Sandton Dr', types: ['route'] },
      { longText: 'Sandhurst',            shortText: 'Sandhurst',  types: ['sublocality_level_1', 'sublocality', 'political'] },
      { longText: 'Sandton',              shortText: 'Sandton',    types: ['locality', 'political'] },
      { longText: 'Gauteng',              shortText: 'GP',         types: ['administrative_area_level_1', 'political'] },
      { longText: '2196',                 shortText: '2196',       types: ['postal_code'] },
      { longText: 'South Africa',         shortText: 'ZA',         types: ['country', 'political'] },
    ];
    const r = parseAddressComponents(components);
    expect(r.addressLine1).toBe('1 Sandton Drive');
    expect(r.suburb).toBe('Sandhurst');
    expect(r.city).toBe('Sandton');
    expect(r.province).toBe('Gauteng');
    expect(r.postalCode).toBe('2196');
  });

  it('returns nulls when components are sparse (defensive)', () => {
    const r = parseAddressComponents([]);
    expect(r.addressLine1).toBeNull();
    expect(r.suburb).toBeNull();
    expect(r.city).toBeNull();
    expect(r.province).toBeNull();
    expect(r.postalCode).toBeNull();
  });

  it('pluckComponent matches the FIRST type tag found', () => {
    const components = [
      { longText: 'Joburg', shortText: 'JHB', types: ['locality'] },
    ];
    expect(pluckComponent(components, 'locality')).toBe('Joburg');
    expect(pluckComponent(components, 'street_number')).toBeNull();
  });
});
