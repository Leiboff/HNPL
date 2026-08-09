import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── devices/actions — manager-gated till administration ──────────────────
//
// Normal per-user login model (guardTillManager, can_manage_practice) —
// UNCHANGED auth, same generic filter-tracking mock style as
// activateFirstInstalment.test.ts / app/practice/pos/actions.test.ts.
// Covers: non-manager rejected / manager succeeds for each export, plus
// setTillPin's format validation and revokeDevice's own-practice scope
// check (belt-and-braces on top of the RLS UPDATE policy).

type Row = Record<string, unknown>;
const inserts: Array<{ table: string; row: Row }> = [];
const updates: Array<{ table: string; patch: Row; filters: Array<[string, unknown]> }> = [];
let state: Record<string, Row[]> = {};
let sessionUserId: string | null = 'manager-1';

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([c, v]) => row[c] === v);
}

function makeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: sessionUserId ? { id: sessionUserId } : null }, error: null }) },
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b; };
      b.order = () => b;
      b.limit = (n: number) => {
        const rows = (state[table] ?? []).filter((r) => matches(r, filters));
        return Promise.resolve({ data: rows.slice(0, n), error: null });
      };
      b.maybeSingle = async () => ({
        data: (state[table] ?? []).find((r) => matches(r, filters)) ?? null,
        error: null,
      });
      // Some chains (e.g. listDevices) terminate on .order() with no
      // .maybeSingle()/.limit() call — the chain itself is awaited
      // directly, so it must be thenable.
      b.then = (resolve: (v: unknown) => void) => resolve({
        data: (state[table] ?? []).filter((r) => matches(r, filters)),
        error: null,
      });
      b.insert = (row: Row) => {
        inserts.push({ table, row });
        (state[table] ??= []).push({ id: `${table}-${(state[table]?.length ?? 0) + 1}`, ...row });
        return Promise.resolve({ data: null, error: null });
      };
      b.update = (patch: Row) => {
        const upFilters: Array<[string, unknown]> = [...filters];
        const updB: Record<string, unknown> = {};
        updB.eq = (c: string, v: unknown) => {
          upFilters.push([c, v]);
          for (const r of (state[table] ?? [])) {
            if (matches(r, upFilters)) Object.assign(r, patch);
          }
          updates.push({ table, patch, filters: upFilters });
          return Promise.resolve({ data: null, error: null });
        };
        return updB;
      };
      return b;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeClient()),
}));

beforeEach(() => {
  inserts.length = 0;
  updates.length = 0;
  sessionUserId = 'manager-1';
  process.env.TILL_AUTH_PEPPER = 'test-pepper';
  state = {
    practice_members: [
      { user_id: 'manager-1', practice_id: 'practice-1', active: true, can_manage_practice: true, created_at: '2024-01-01' },
      { user_id: 'biller-1',  practice_id: 'practice-1', active: true, can_manage_practice: false, created_at: '2024-01-01' },
    ],
    till_devices: [
      { id: 'device-1', practice_id: 'practice-1', label: null, registered_at: '2024-01-01', revoked_at: null, last_activity_at: null, unlocked_at: null, pin_attempts: 0, pin_locked_until: null },
      { id: 'device-other', practice_id: 'practice-2', label: null, registered_at: '2024-01-01', revoked_at: null, last_activity_at: null, unlocked_at: null, pin_attempts: 0, pin_locked_until: null },
    ],
    practices: [
      { id: 'practice-1', till_pin_hash: null },
    ],
    till_device_registration_codes: [],
  };
});

import {
  generateDeviceRegistrationCode,
  listDevices,
  revokeDevice,
  setTillPin,
  hasTillPin,
} from './actions';

describe('guardTillManager — non-manager rejected on every export', () => {
  it('generateDeviceRegistrationCode rejects a biller (not a manager)', async () => {
    sessionUserId = 'biller-1';
    const result = await generateDeviceRegistrationCode();
    expect(result.error).toMatch(/permission/i);
    expect(inserts).toHaveLength(0);
  });

  it('listDevices rejects a biller', async () => {
    sessionUserId = 'biller-1';
    const result = await listDevices();
    expect(result.error).toMatch(/permission/i);
    expect(result.devices).toBeUndefined();
  });

  it('revokeDevice rejects a biller', async () => {
    sessionUserId = 'biller-1';
    const result = await revokeDevice('device-1');
    expect(result.error).toMatch(/permission/i);
    expect(updates).toHaveLength(0);
  });

  it('setTillPin rejects a biller', async () => {
    sessionUserId = 'biller-1';
    const result = await setTillPin('1234');
    expect(result.error).toMatch(/permission/i);
    expect(updates).toHaveLength(0);
  });

  it('hasTillPin rejects a biller', async () => {
    sessionUserId = 'biller-1';
    const result = await hasTillPin();
    expect(result.error).toMatch(/permission/i);
    expect(result.hasPin).toBeUndefined();
  });

  it('rejects an unauthenticated caller entirely', async () => {
    sessionUserId = null;
    const result = await listDevices();
    expect(result.error).toMatch(/session expired|log in/i);
  });
});

describe('generateDeviceRegistrationCode — manager success', () => {
  it('inserts an 8-digit hashed code scoped to the manager\'s practice, returns it once in plaintext', async () => {
    const result = await generateDeviceRegistrationCode();
    expect(result.error).toBeNull();
    expect(result.code).toMatch(/^\d{8}$/);
    expect(result.expiresAt).toBeTruthy();

    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('till_device_registration_codes');
    expect(inserts[0].row.practice_id).toBe('practice-1');
    expect(inserts[0].row.created_by).toBe('manager-1');
    // Stored hashed, not plaintext.
    expect(inserts[0].row.code_hash).not.toBe(result.code);
  });
});

describe('listDevices — manager success', () => {
  it('returns only the manager\'s own practice\'s devices', async () => {
    const result = await listDevices();
    expect(result.error).toBeNull();
    expect(result.devices).toHaveLength(1);
    expect(result.devices![0].id).toBe('device-1');
  });
});

describe('revokeDevice — manager success + own-practice scope check', () => {
  it('sets revoked_at + revoked_by on the manager\'s own device', async () => {
    const result = await revokeDevice('device-1');
    expect(result.error).toBeNull();
    const row = state.till_devices.find((d) => d.id === 'device-1')!;
    expect(row.revoked_at).toBeTruthy();
    expect(row.revoked_by).toBe('manager-1');
  });

  it('refuses to revoke a device belonging to a DIFFERENT practice', async () => {
    const result = await revokeDevice('device-other');
    expect(result.error).toMatch(/not found/i);
    const row = state.till_devices.find((d) => d.id === 'device-other')!;
    expect(row.revoked_at).toBeNull();
    expect(updates).toHaveLength(0);
  });
});

describe('setTillPin — format validation + manager success', () => {
  it('rejects a PIN outside 4-6 digits', async () => {
    const tooShort = await setTillPin('123');
    expect(tooShort.error).toMatch(/4-6 digits/);
    const tooLong = await setTillPin('1234567');
    expect(tooLong.error).toMatch(/4-6 digits/);
    const nonNumeric = await setTillPin('12ab');
    expect(nonNumeric.error).toMatch(/4-6 digits/);
    expect(updates).toHaveLength(0);
  });

  it('sets till_pin_hash on the practice and resets pin_attempts/pin_locked_until on all its devices', async () => {
    state.till_devices[0].pin_attempts = 5;
    state.till_devices[0].pin_locked_until = new Date(Date.now() + 60_000).toISOString();

    const result = await setTillPin('123456');
    expect(result.error).toBeNull();

    const practice = state.practices.find((p) => p.id === 'practice-1')!;
    expect(practice.till_pin_hash).toBeTruthy();

    const device = state.till_devices.find((d) => d.id === 'device-1')!;
    expect(device.pin_attempts).toBe(0);
    expect(device.pin_locked_until).toBeNull();

    // The other practice's device is untouched.
    const other = state.till_devices.find((d) => d.id === 'device-other')!;
    expect(other.pin_attempts).toBe(0); // was already 0, and must not have been written by this call
  });
});

describe('hasTillPin — manager success', () => {
  it('reports false when till_pin_hash is null', async () => {
    const result = await hasTillPin();
    expect(result.error).toBeNull();
    expect(result.hasPin).toBe(false);
  });

  it('reports true once a PIN has been set', async () => {
    state.practices[0].till_pin_hash = 'some-hash';
    const result = await hasTillPin();
    expect(result.hasPin).toBe(true);
  });
});
