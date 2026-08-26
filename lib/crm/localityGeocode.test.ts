import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { geocodeLocality, geocodeLocalities, normaliseLocalityQuery, resolveLocalitiesWithCache } from './localityGeocode';

// ─── Tests for the server-only locality Text Search wrapper ────────────
//
// What these pin:
//   • POSTs to the Places (New) Text Search v1 endpoint with
//     X-Goog-Api-Key (the SERVER key, not the browser one) +
//     X-Goog-FieldMask, and a textQuery biased to South Africa.
//   • Missing key / non-2xx / network failure all resolve to null,
//     never throw — a bulk import must survive a bad row.
//   • geocodeLocalities() calls Google once per DISTINCT normalised
//     query, not once per input row.
//   • resolveLocalitiesWithCache() checks the persistent cache FIRST
//     and only calls Google for cache misses, then writes fresh
//     results back to the cache for next time.

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.GOOGLE_PLACES_SERVER_KEY = 'TEST_SERVER_KEY';
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.GOOGLE_PLACES_SERVER_KEY;
});

describe('normaliseLocalityQuery', () => {
  it('trims, lowercases, and collapses whitespace', () => {
    expect(normaliseLocalityQuery('  Springs ,  Springs, Gauteng  ')).toBe('springs , springs, gauteng');
  });
});

describe('geocodeLocality — request shape', () => {
  it('POSTs to the Text Search endpoint with the server key + field mask + ZA bias', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ places: [{ location: { latitude: -26.25, longitude: 28.44 }, formattedAddress: 'Springs, Gauteng' }] }),
    });
    global.fetch = fetchSpy;

    const result = await geocodeLocality('Springs, Springs, Gauteng');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('TEST_SERVER_KEY');
    expect(headers['X-Goog-FieldMask']).toBe('places.location,places.formattedAddress');
    const body = JSON.parse(init.body as string);
    expect(body.textQuery).toBe('Springs, Springs, Gauteng, South Africa');
    expect(body.regionCode).toBe('ZA');

    expect(result).toEqual({ lat: -26.25, lng: 28.44, formattedAddress: 'Springs, Gauteng' });
  });

  it('returns null when no key is configured', async () => {
    delete process.env.GOOGLE_PLACES_SERVER_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    expect(await geocodeLocality('Springs, Gauteng')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null on empty input without calling fetch', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    expect(await geocodeLocality('   ')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    expect(await geocodeLocality('Springs, Gauteng')).toBeNull();
  });

  it('returns null when no place / location comes back', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ places: [] }) });
    expect(await geocodeLocality('Nonexistent Place, Gauteng')).toBeNull();
  });

  it('returns null (never throws) on a network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    expect(await geocodeLocality('Springs, Gauteng')).toBeNull();
  });
});

describe('geocodeLocalities — dedup across rows', () => {
  it('calls fetch once per DISTINCT normalised query, mapping every input to a result', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ places: [{ location: { latitude: -26.25, longitude: 28.44 }, formattedAddress: 'x' }] }),
    });
    global.fetch = fetchSpy;

    const queries = [
      'Springs, Springs, Gauteng',
      'Springs, Springs, Gauteng',   // exact dupe
      '  springs,  springs, gauteng ', // dupe after normalisation
      'Bedfordview, Germiston, Gauteng',
    ];
    const results = await geocodeLocalities(queries);

    expect(fetchSpy).toHaveBeenCalledTimes(2); // two distinct localities
    expect(results.get('springs, springs, gauteng')).toEqual({ lat: -26.25, lng: 28.44, formattedAddress: 'x' });
    expect(results.get('bedfordview, germiston, gauteng')).toEqual({ lat: -26.25, lng: 28.44, formattedAddress: 'x' });
  });

  it('resolves to an empty map without calling fetch for an empty input list', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const results = await geocodeLocalities([]);
    expect(results.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── resolveLocalitiesWithCache — persistent cache in front of Google ──

function makeSupabaseMock(cachedRows: Array<{ query_normalised: string; latitude: number; longitude: number; formatted_address: string | null }>) {
  const inSpy     = vi.fn().mockResolvedValue({ data: cachedRows });
  const selectSpy = vi.fn().mockReturnValue({ in: inSpy });
  const upsertSpy = vi.fn().mockResolvedValue({ error: null });
  const from      = vi.fn().mockReturnValue({ select: selectSpy, upsert: upsertSpy });
  return { from, selectSpy, inSpy, upsertSpy };
}

describe('resolveLocalitiesWithCache', () => {
  it('serves a fully-cached batch entirely from the cache — no Google call at all', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const supabase = makeSupabaseMock([
      { query_normalised: 'springs, springs, gauteng', latitude: -26.25, longitude: 28.44, formatted_address: 'Springs, Gauteng' },
    ]);

    const results = await resolveLocalitiesWithCache(supabase, ['Springs, Springs, Gauteng']);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledWith('crm_locality_geocode_cache');
    expect(supabase.inSpy).toHaveBeenCalledWith('query_normalised', ['springs, springs, gauteng']);
    expect(results.get('springs, springs, gauteng')).toEqual({ lat: -26.25, lng: 28.44, formattedAddress: 'Springs, Gauteng' });
    expect(supabase.upsertSpy).not.toHaveBeenCalled(); // nothing new to write back
  });

  it('only calls Google for cache MISSES, then writes the fresh result back to the cache', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ places: [{ location: { latitude: -26.1, longitude: 28.1 }, formattedAddress: 'Bedfordview, Gauteng' }] }),
    });
    global.fetch = fetchSpy;
    // Only Springs is cached; Bedfordview is a miss.
    const supabase = makeSupabaseMock([
      { query_normalised: 'springs, springs, gauteng', latitude: -26.25, longitude: 28.44, formatted_address: 'Springs, Gauteng' },
    ]);

    const results = await resolveLocalitiesWithCache(supabase, [
      'Springs, Springs, Gauteng',
      'Bedfordview, Germiston, Gauteng',
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the miss went to Google
    expect(results.get('springs, springs, gauteng')).toEqual({ lat: -26.25, lng: 28.44, formattedAddress: 'Springs, Gauteng' });
    expect(results.get('bedfordview, germiston, gauteng')).toEqual({ lat: -26.1, lng: 28.1, formattedAddress: 'Bedfordview, Gauteng' });

    expect(supabase.upsertSpy).toHaveBeenCalledTimes(1);
    const [rows, opts] = supabase.upsertSpy.mock.calls[0];
    expect(rows).toEqual([{ query_normalised: 'bedfordview, germiston, gauteng', latitude: -26.1, longitude: 28.1, formatted_address: 'Bedfordview, Gauteng' }]);
    expect(opts).toEqual({ onConflict: 'query_normalised', ignoreDuplicates: true });
  });

  it('does not cache a miss that fails to geocode', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ places: [] }) });
    const supabase = makeSupabaseMock([]);

    const results = await resolveLocalitiesWithCache(supabase, ['Nonexistent Place, Gauteng']);

    expect(results.get('nonexistent place, gauteng')).toBeNull();
    expect(supabase.upsertSpy).not.toHaveBeenCalled();
  });

  it('returns an empty map without touching Supabase or Google for an empty input list', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const supabase = makeSupabaseMock([]);

    const results = await resolveLocalitiesWithCache(supabase, []);

    expect(results.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
