import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/security/rateLimit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/security/rateLimit')>(),
  ...(await import('@/lib/testing/rateLimitTestMock')).allowTestRateLimit,
}));

vi.mock('@/lib/risk/evaluate', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/risk/evaluate')>(),
  ...(await import('@/lib/testing/riskTestMock')).allowTestRisk,
}));

// ─── redeemDeviceRegistrationCode + checkDeviceStatus ──────────────────────
//
// redeemDeviceRegistrationCode: TS-level format validation + error mapping
// on top of the already pglite-tested RPC (0088_till_devices.rpc.test.ts
// proves the RPC's own atomicity/rejection logic; this file proves the TS
// wrapper maps each `result` value to the right caller-facing message and
// never hands the RPC a raw, unhashed value).
//
// checkDeviceStatus: the ADVERSARIAL property from the Build D spec —
// every state before 'unlocked' must carry ZERO practice-scoped data.
// Asserted by inspecting the actual returned object's keys/values, not by
// rendering anything.

const DEVICE_SECRET = 'device-secret-under-test';
const DEVICE_ID     = 'device-1';
const PRACTICE_ID   = 'practice-1';
const PRACTICE_NAME = 'Real Practice Name — must never leak pre-unlock';

type Row = Record<string, unknown>;
let state: Record<string, Row[]> = {};
let rpcResult: { data: unknown; error: unknown } = { data: null, error: null };
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([c, v]) => row[c] === v);
}

function makeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b; };
      b.maybeSingle = async () => ({
        data: (state[table] ?? []).find((r) => matches(r, filters)) ?? null,
        error: null,
      });
      b.update = (patch: Row) => ({
        eq: (c: string, v: unknown) => {
          for (const r of (state[table] ?? [])) {
            if (matches(r, [...filters, [c, v]])) Object.assign(r, patch);
          }
          return Promise.resolve({ data: null, error: null });
        },
      });
      // practice_members(...).select(...).eq(...).eq(...).eq(...) is
      // awaited directly with no terminal maybeSingle/limit call.
      b.then = (resolve: (v: unknown) => void) => resolve({
        data: (state[table] ?? []).filter((r) => matches(r, filters)),
        error: null,
      });
      return b;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcResult;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => makeClient()),
}));

beforeEach(async () => {
  rpcCalls.length = 0;
  rpcResult = { data: null, error: null };
  process.env.TILL_AUTH_PEPPER = 'test-pepper';
  const { hashTillSecret } = await import('@/lib/auth/tillDevice');
  state = {
    till_devices: [{
      id:               DEVICE_ID,
      practice_id:      PRACTICE_ID,
      secret_hash:      hashTillSecret(DEVICE_SECRET),
      revoked_at:       null,
      unlocked_at:      new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
    }],
    practices: [{ id: PRACTICE_ID, name: PRACTICE_NAME }],
    practice_members: [{
      id: 'mem-1', user_id: 'provider-1', practice_id: PRACTICE_ID, active: true, role: 'provider',
      provider_first_name: null, provider_last_name: null, specialty: null,
      profiles: { first_name: 'Jane', last_name: 'Doe' },
    }, {
      // Roster-only: the till must offer them too, with the name resolved
      // from the membership rather than a profile that does not exist.
      id: 'mem-roster', user_id: null, practice_id: PRACTICE_ID, active: true, role: 'provider',
      provider_first_name: 'Zanele', provider_last_name: 'Mthembu', specialty: 'Optometry',
      profiles: null,
    }],
  };
});

import { redeemDeviceRegistrationCode, checkDeviceStatus } from './actions';

describe('redeemDeviceRegistrationCode — format validation', () => {
  it('rejects a code that is not exactly 8 digits, without calling the RPC', async () => {
    const result = await redeemDeviceRegistrationCode('1234', 'Front desk PC', 'test-ua');
    expect(result.error).toBeTruthy();
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('redeemDeviceRegistrationCode — error mapping', () => {
  it('maps invalid_code', async () => {
    rpcResult = { data: [{ result: 'invalid_code', device_id: null, practice_id: null }], error: null };
    const result = await redeemDeviceRegistrationCode('12345678', 'Front desk PC', 'test-ua');
    expect(result.error).toMatch(/not valid/i);
  });

  it('maps already_used', async () => {
    rpcResult = { data: [{ result: 'already_used', device_id: null, practice_id: null }], error: null };
    const result = await redeemDeviceRegistrationCode('12345678', 'Front desk PC', 'test-ua');
    expect(result.error).toMatch(/already been used/i);
  });

  it('maps expired', async () => {
    rpcResult = { data: [{ result: 'expired', device_id: null, practice_id: null }], error: null };
    const result = await redeemDeviceRegistrationCode('12345678', 'Front desk PC', 'test-ua');
    expect(result.error).toMatch(/expired/i);
  });

  it('maps a transport-level RPC error to a generic message', async () => {
    rpcResult = { data: null, error: { message: 'connection reset' } };
    const result = await redeemDeviceRegistrationCode('12345678', 'Front desk PC', 'test-ua');
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/connection reset/); // no internal error leakage
  });
});

describe('redeemDeviceRegistrationCode — success', () => {
  it('calls the RPC with HASHED code + a freshly generated hashed secret, returns the plaintext secret once', async () => {
    rpcResult = { data: [{ result: 'ok', device_id: 'new-device', practice_id: PRACTICE_ID }], error: null };
    const result = await redeemDeviceRegistrationCode('12345678', 'Front desk PC', 'test-ua');
    expect(result.error).toBeNull();
    expect(result.deviceSecret).toBeTruthy();

    expect(rpcCalls).toHaveLength(1);
    const args = rpcCalls[0].args;
    // Neither the raw code nor a predictable value — hashed inputs only.
    expect(args.p_code_hash).not.toBe('12345678');
    expect(args.p_secret_hash).not.toBe(result.deviceSecret);
  });
});

describe('checkDeviceStatus — no practice data leaks before unlocked', () => {
  it('no_device: returns exactly {state} — no practice fields at all', async () => {
    const result = await checkDeviceStatus(null);
    expect(result).toEqual({ state: 'no_device' });
    expect(Object.keys(result)).toEqual(['state']);
  });

  it('no_device for an unrecognized secret: still exactly {state}', async () => {
    const result = await checkDeviceStatus('not-the-real-secret');
    expect(result).toEqual({ state: 'no_device' });
  });

  it('revoked: exactly {state} — practice name never included even though the device is real', async () => {
    state.till_devices[0].revoked_at = new Date().toISOString();
    const result = await checkDeviceStatus(DEVICE_SECRET);
    expect(result).toEqual({ state: 'revoked' });
    expect(JSON.stringify(result)).not.toContain(PRACTICE_NAME);
    expect(JSON.stringify(result)).not.toContain(PRACTICE_ID);
  });

  it('locked (never unlocked): exactly {state} — practice name never included', async () => {
    state.till_devices[0].unlocked_at = null;
    const result = await checkDeviceStatus(DEVICE_SECRET);
    expect(result).toEqual({ state: 'locked' });
    expect(JSON.stringify(result)).not.toContain(PRACTICE_NAME);
    expect(JSON.stringify(result)).not.toContain(PRACTICE_ID);
  });

  it('locked (idle timeout): exactly {state} — practice name never included', async () => {
    state.till_devices[0].last_activity_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const result = await checkDeviceStatus(DEVICE_SECRET);
    expect(result).toEqual({ state: 'locked' });
  });
});

describe('checkDeviceStatus — unlocked returns practice-scoped data, sourced from THIS call only', () => {
  it('returns practiceId, practiceName, and mapped providers', async () => {
    const result = await checkDeviceStatus(DEVICE_SECRET);
    expect(result.state).toBe('unlocked');
    if (result.state !== 'unlocked') throw new Error('unreachable');
    expect(result.practiceId).toBe(PRACTICE_ID);
    expect(result.practiceName).toBe(PRACTICE_NAME);
    // Membership-keyed since 0094, name pre-resolved, sorted by name.
    expect(result.providers).toEqual([
      { memberId: 'mem-1',      name: 'Jane Doe' },
      { memberId: 'mem-roster', name: 'Zanele Mthembu' },
    ]);
  });
});
