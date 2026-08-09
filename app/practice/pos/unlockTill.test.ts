import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── unlockTill — daily/idle PIN unlock + brute-force lockout ─────────────
//
// PIN_MAX_ATTEMPTS=5 / PIN_LOCKOUT_MS=15min (lib/auth/tillDevice.ts).
// The lockout check runs BEFORE the PIN comparison, so a locked-out till
// rejects even a subsequently-CORRECT PIN until pin_locked_until elapses.

const DEVICE_SECRET = 'device-secret-under-test';
const DEVICE_ID     = 'device-1';
const PRACTICE_ID   = 'practice-1';
const CORRECT_PIN   = '135790';

type Row = Record<string, unknown>;
let state: Record<string, Row[]> = {};

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
      return b;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => makeClient()),
}));

beforeEach(async () => {
  process.env.TILL_AUTH_PEPPER = 'test-pepper';
  const { hashTillSecret } = await import('@/lib/auth/tillDevice');
  state = {
    till_devices: [{
      id:               DEVICE_ID,
      practice_id:      PRACTICE_ID,
      secret_hash:      hashTillSecret(DEVICE_SECRET),
      revoked_at:       null,
      pin_attempts:     0,
      pin_locked_until: null,
    }],
    practices: [{
      id:            PRACTICE_ID,
      till_pin_hash: hashTillSecret(CORRECT_PIN),
    }],
  };
});

import { unlockTill } from './actions';

function device() {
  return state.till_devices.find((d) => d.id === DEVICE_ID)!;
}

describe('unlockTill — correct PIN', () => {
  it('unlocks, stamps unlocked_at/last_activity_at, and resets attempts', async () => {
    const result = await unlockTill(DEVICE_SECRET, CORRECT_PIN);
    expect(result.error).toBeNull();
    expect(device().unlocked_at).toBeTruthy();
    expect(device().last_activity_at).toBeTruthy();
    expect(device().pin_attempts).toBe(0);
    expect(device().pin_locked_until).toBeNull();
  });
});

describe('unlockTill — wrong PIN attempts', () => {
  it('increments pin_attempts on a wrong PIN without unlocking', async () => {
    const result = await unlockTill(DEVICE_SECRET, '000000');
    expect(result.error).toMatch(/incorrect/i);
    expect(device().pin_attempts).toBe(1);
    expect(device().unlocked_at).toBeFalsy();
    expect(device().pin_locked_until).toBeNull();
  });

  it('locks the till on the 5th wrong attempt and rejects even a CORRECT PIN until cooldown elapses', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await unlockTill(DEVICE_SECRET, '000000');
      expect(r.error).toMatch(/incorrect/i);
    }
    expect(device().pin_attempts).toBe(4);
    expect(device().pin_locked_until).toBeNull();

    // 5th wrong attempt trips the lockout.
    const fifth = await unlockTill(DEVICE_SECRET, '000000');
    expect(fifth.error).toMatch(/locked for 15 minutes/i);
    expect(device().pin_attempts).toBe(5);
    expect(device().pin_locked_until).toBeTruthy();

    // Even the CORRECT PIN is rejected now — the lockout check runs
    // before the PIN comparison.
    const correctButLocked = await unlockTill(DEVICE_SECRET, CORRECT_PIN);
    expect(correctButLocked.error).toMatch(/too many incorrect attempts/i);
    expect(device().unlocked_at).toBeFalsy();
  });

  it('a correct PIN after the cooldown elapses succeeds and resets attempts', async () => {
    device().pin_attempts = 5;
    device().pin_locked_until = new Date(Date.now() - 1000).toISOString(); // already elapsed

    const result = await unlockTill(DEVICE_SECRET, CORRECT_PIN);
    expect(result.error).toBeNull();
    expect(device().pin_attempts).toBe(0);
    expect(device().pin_locked_until).toBeNull();
    expect(device().unlocked_at).toBeTruthy();
  });
});

describe('unlockTill — device/practice state guards', () => {
  it('rejects an unrecognized device secret', async () => {
    const result = await unlockTill('not-the-real-secret', CORRECT_PIN);
    expect(result.error).toMatch(/not registered/i);
  });

  it('rejects a revoked device', async () => {
    device().revoked_at = new Date().toISOString();
    const result = await unlockTill(DEVICE_SECRET, CORRECT_PIN);
    expect(result.error).toMatch(/revoked/i);
  });

  it('rejects with a clear message when no PIN has been set for the practice', async () => {
    state.practices[0].till_pin_hash = null;
    const result = await unlockTill(DEVICE_SECRET, CORRECT_PIN);
    expect(result.error).toMatch(/no till pin has been set/i);
  });
});
