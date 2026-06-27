import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Tests for the Places-driven admin actions ──────────────────────────
//
// Replaces the old geocoding-actions.test.ts. Pins:
//   • Admin authz gate fires BEFORE any DB write.
//   • updatePracticeAddressFromPlace writes lat/long + address fields
//     when the payload is valid + in-SA-range.
//   • SA-range backstop rejects tampered-client payloads.
//   • setPracticeCoordinates (manual override) keeps SA-range validation.
//   • clearPracticeCoordinates nulls both columns.
//   • NO Geocoding API call appears in any of these — the actions
//     accept resolved place data and just write.

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const profileRole: { value: string | null } = { value: null };
const userId:      { value: string | null } = { value: 'admin-1' };
const updates: Array<{ row: Record<string, unknown> }> = [];

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
      return {
        update: (row: Record<string, unknown>) => ({
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
  updates.length = 0;
  profileRole.value = 'admin';
  userId.value      = 'admin-1';
});

import {
  updatePracticeAddressFromPlace,
  setPracticeCoordinates,
  clearPracticeCoordinates,
} from './actions';

describe('updatePracticeAddressFromPlace — admin gate + write', () => {
  it('rejects an unauthenticated caller (no DB write)', async () => {
    userId.value = null;
    const r = await updatePracticeAddressFromPlace('p1', {
      latitude: -26.107567, longitude: 28.056456,
      formattedAddress: '1 Sandton Drive, Sandton, South Africa',
    });
    expect(r.error).toBe('Not authenticated.');
    expect(updates).toHaveLength(0);
  });

  it('rejects a non-admin caller (no DB write)', async () => {
    profileRole.value = 'patient';
    const r = await updatePracticeAddressFromPlace('p1', {
      latitude: -26.107567, longitude: 28.056456,
      formattedAddress: 'X',
    });
    expect(r.error).toBe('Unauthorized.');
    expect(updates).toHaveLength(0);
  });

  it('writes lat/long + formatted address + parsed components when valid', async () => {
    const r = await updatePracticeAddressFromPlace('p1', {
      latitude:         -26.107567,
      longitude:         28.056456,
      formattedAddress: '1 Sandton Drive, Sandhurst, Sandton, 2196, South Africa',
      suburb:           'Sandhurst',
      city:             'Sandton',
      province:         'Gauteng',
      postalCode:       '2196',
    });
    expect(r.error).toBeNull();
    expect(updates).toHaveLength(1);
    const row = updates[0].row;
    expect(row.latitude).toBeCloseTo(-26.107567, 5);
    expect(row.longitude).toBeCloseTo(28.056456, 5);
    expect(row.address_line1).toMatch(/Sandton Drive/);
    expect(row.suburb).toBe('Sandhurst');
    expect(row.city).toBe('Sandton');
    expect(row.practice_province).toBe('Gauteng');
    expect(row.postal_code).toBe('2196');
  });
});

describe('updatePracticeAddressFromPlace — SA-range backstop (tampered client payload)', () => {
  it('rejects coords outside SA — would otherwise pin the practice in another country', async () => {
    const r = await updatePracticeAddressFromPlace('p1', {
      latitude:  37.7749,    // San Francisco
      longitude: -122.4194,
      formattedAddress: 'Spoofed payload',
    });
    expect(r.error).toMatch(/outside South Africa/i);
    expect(updates).toHaveLength(0);
  });

  it('rejects a sign-flipped latitude', async () => {
    const r = await updatePracticeAddressFromPlace('p1', {
      latitude:   26.107567,   // positive — would land in the Arabian Sea
      longitude:  28.056456,
      formattedAddress: 'Sandton (with flipped sign)',
    });
    expect(r.error).toMatch(/outside South Africa/i);
    expect(updates).toHaveLength(0);
  });

  it('rejects NaN/Infinity coords with a clear message', async () => {
    const r = await updatePracticeAddressFromPlace('p1', {
      latitude: NaN, longitude: 28, formattedAddress: 'X',
    });
    expect(r.error).toMatch(/must be numbers/i);
    expect(updates).toHaveLength(0);
  });

  it('rejects an empty formatted address', async () => {
    const r = await updatePracticeAddressFromPlace('p1', {
      latitude:  -26.107567, longitude: 28.056456,
      formattedAddress: '   ',
    });
    expect(r.error).toMatch(/empty/i);
    expect(updates).toHaveLength(0);
  });
});

describe('setPracticeCoordinates — manual override (kept)', () => {
  it('accepts in-range coordinates', async () => {
    const r = await setPracticeCoordinates('p1', -26.107567, 28.056456);
    expect(r.error).toBeNull();
    expect(updates).toHaveLength(1);
    const row = updates[0].row;
    expect(row.latitude).toBeCloseTo(-26.107567, 5);
    expect(row.longitude).toBeCloseTo(28.056456, 5);
  });

  it('rejects out-of-SA-range coordinates', async () => {
    const r = await setPracticeCoordinates('p1', 26.107567, 28.056456);
    expect(r.error).toMatch(/outside South Africa/i);
    expect(updates).toHaveLength(0);
  });

  it('rejects a non-admin caller', async () => {
    profileRole.value = 'patient';
    const r = await setPracticeCoordinates('p1', -26, 28);
    expect(r.error).toBe('Unauthorized.');
    expect(updates).toHaveLength(0);
  });
});

describe('clearPracticeCoordinates — kept', () => {
  it('nulls both columns', async () => {
    const r = await clearPracticeCoordinates('p1');
    expect(r.error).toBeNull();
    expect(updates).toHaveLength(1);
    const row = updates[0].row;
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
  });
});
