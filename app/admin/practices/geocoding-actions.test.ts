import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Tests for the admin-side geocoding + manual-coord actions ─────────
//
// Pins:
//   • Admin authz gate fires BEFORE any geocoding call or DB write.
//   • Manual coord entry: in-SA accepted, out-of-SA rejected.
//   • Re-geocode failure surfaces a user-readable error AND does not
//     write to the DB.
//   • Re-geocode success writes lat/long to the practice row.

const geocodeAddressSpy = vi.fn();
vi.mock('@/lib/maps/geocode', async () => {
  const actual = await vi.importActual<typeof import('@/lib/maps/geocode')>('@/lib/maps/geocode');
  return {
    ...actual,
    geocodeAddress: (...args: unknown[]) => geocodeAddressSpy(...args),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const profileRole: { value: string | null } = { value: null };
const userId:      { value: string | null } = { value: 'admin-1' };
const practiceRow: { value: Record<string, unknown> | null } = { value: null };
const updates: Array<{ row: unknown }> = [];

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({
        data: { user: userId.value ? { id: userId.value } : null },
        error: null,
      }),
    },
    from(_table: string) {
      function selectChain() {
        return {
          eq: () => selectChain(),
          single: async () => ({
            data: profileRole.value ? { role: profileRole.value } : null,
            error: null,
          }),
        };
      }
      return { select: selectChain };
    },
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from(_table: string) {
      function selectChain() {
        return {
          eq: () => selectChain(),
          maybeSingle: async () => ({ data: practiceRow.value, error: null }),
        };
      }
      return {
        select: selectChain,
        update: (row: unknown) => ({
          eq: () => {
            updates.push({ row });
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
    },
  })),
}));

beforeEach(() => {
  geocodeAddressSpy.mockReset();
  updates.length = 0;
  profileRole.value = 'admin';
  userId.value      = 'admin-1';
  practiceRow.value = {
    address_line1:     '1 Sandton Drive',
    suburb:            'Sandhurst',
    city:              'Sandton',
    practice_province: 'Gauteng',
    postal_code:       '2196',
  };
});

import {
  regeocodePractice,
  setPracticeCoordinates,
  clearPracticeCoordinates,
} from './actions';

describe('regeocodePractice — admin gate', () => {
  it('rejects an unauthenticated caller (no geocode call)', async () => {
    userId.value = null;
    const r = await regeocodePractice('p1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Not authenticated.');
    expect(geocodeAddressSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-admin caller (no geocode call, no DB write)', async () => {
    profileRole.value = 'patient';
    const r = await regeocodePractice('p1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Unauthorized.');
    expect(geocodeAddressSpy).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});

describe('regeocodePractice — geocoding outcomes', () => {
  it('writes lat/long when geocoding succeeds', async () => {
    geocodeAddressSpy.mockResolvedValue({
      ok: true, latitude: -26.107567, longitude: 28.056456, formatted: 'Sandton',
    });
    const r = await regeocodePractice('p1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.latitude).toBeCloseTo(-26.107567, 5);
    expect(updates).toHaveLength(1);
    expect((updates[0].row as Record<string, unknown>).latitude).toBeCloseTo(-26.107567, 5);
    expect((updates[0].row as Record<string, unknown>).longitude).toBeCloseTo(28.056456, 5);
  });

  it('surfaces a user-readable error on no_results and does NOT write', async () => {
    geocodeAddressSpy.mockResolvedValue({ ok: false, reason: 'no_results' });
    const r = await regeocodePractice('p1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no match/i);
    expect(updates).toHaveLength(0);
  });

  it('surfaces "geocoding not configured" when the key is missing', async () => {
    geocodeAddressSpy.mockResolvedValue({ ok: false, reason: 'not_configured' });
    const r = await regeocodePractice('p1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not configured/i);
    expect(updates).toHaveLength(0);
  });

  it('returns "no address on file" when the row has no address fields', async () => {
    practiceRow.value = {
      address_line1: null, suburb: null, city: null,
      practice_province: null, postal_code: null,
    };
    const r = await regeocodePractice('p1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no address/i);
    expect(geocodeAddressSpy).not.toHaveBeenCalled();
  });
});

describe('setPracticeCoordinates — SA range validation', () => {
  it('accepts an in-range coordinate (Sandton)', async () => {
    const r = await setPracticeCoordinates('p1', -26.107567, 28.056456);
    expect(r.error).toBeNull();
    expect(updates).toHaveLength(1);
  });

  it('rejects a transposed-sign latitude (would put practice in the Arabian Sea)', async () => {
    const r = await setPracticeCoordinates('p1', 26.107567, 28.056456);
    expect(r.error).toMatch(/outside South Africa/i);
    expect(updates).toHaveLength(0);
  });

  it('rejects a US-style longitude', async () => {
    const r = await setPracticeCoordinates('p1', -26.107567, -122.4194);
    expect(r.error).toMatch(/outside South Africa/i);
    expect(updates).toHaveLength(0);
  });

  it('rejects NaN coordinates with a clear message', async () => {
    const r = await setPracticeCoordinates('p1', NaN, 28);
    expect(r.error).toMatch(/must be numbers/i);
    expect(updates).toHaveLength(0);
  });

  it('rejects a non-admin caller before any validation', async () => {
    profileRole.value = 'patient';
    const r = await setPracticeCoordinates('p1', -26, 28);
    expect(r.error).toBe('Unauthorized.');
    expect(updates).toHaveLength(0);
  });
});

describe('clearPracticeCoordinates', () => {
  it('nulls both columns when the admin clicks Clear', async () => {
    const r = await clearPracticeCoordinates('p1');
    expect(r.error).toBeNull();
    expect(updates).toHaveLength(1);
    const row = updates[0].row as Record<string, unknown>;
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
  });

  it('rejects a non-admin caller', async () => {
    profileRole.value = 'patient';
    const r = await clearPracticeCoordinates('p1');
    expect(r.error).toBe('Unauthorized.');
    expect(updates).toHaveLength(0);
  });
});
