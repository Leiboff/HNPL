import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── lib/auth/tillDevice — hashing + requireUnlockedDevice ─────────────
//
// requireUnlockedDevice's DECISION logic (idle timeout, day-boundary,
// revoked, no_device) is ordinary conditional business logic over
// timestamps read from the database — not an RLS/grant question (that's
// covered by the real-pglite RLS tests for till_devices). A mocked
// Supabase client is the right tool here, same as the rest of this
// codebase's non-RLS business-logic tests (e.g. activateFirstInstalment).

type Row = Record<string, unknown>;
let deviceRow: Row | null = null;
let updates: Row[] = [];

function makeClient() {
  return {
    from(table: string) {
      expect(table).toBe('till_devices');
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: deviceRow, error: null });
      b.update = (patch: Row) => {
        updates.push(patch);
        if (deviceRow) Object.assign(deviceRow, patch);
        return { eq: () => Promise.resolve({ data: null, error: null }) };
      };
      return b;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => makeClient()),
}));

beforeEach(() => {
  process.env.TILL_AUTH_PEPPER = 'test-pepper';
  updates = [];
  deviceRow = null;
});

import {
  hashTillSecret,
  hashTillPin,
  verifyTillPin,
  requireUnlockedDevice,
  TILL_IDLE_TIMEOUT_MS,
} from './tillDevice';

describe('hashTillSecret', () => {
  it('is deterministic for the same input', () => {
    expect(hashTillSecret('abc')).toBe(hashTillSecret('abc'));
  });

  it('differs for different inputs', () => {
    expect(hashTillSecret('abc')).not.toBe(hashTillSecret('abd'));
  });

  it('changes if the pepper changes (defense against a leaked hash alone)', () => {
    const before = hashTillSecret('abc');
    process.env.TILL_AUTH_PEPPER = 'different-pepper';
    expect(hashTillSecret('abc')).not.toBe(before);
  });

  it('throws a clear error when the pepper is unset', () => {
    delete process.env.TILL_AUTH_PEPPER;
    expect(() => hashTillSecret('abc')).toThrow('TILL_AUTH_PEPPER');
  });
});

// ─── The practice PIN gets a slow, salted hash (audit F-14) ────────────
//
// till_pin_hash was SHA-256(pin + pepper) over a 4-6 digit space — one
// GPU-second to recover every practice PIN in the table if the database
// and the pepper ever leak together. Unlike the other two secrets this one
// is long-lived: it persists until a manager rotates it.
//
// It is also the only one of the three that is COMPARED rather than looked
// up (unlockTill has already resolved the device, so it knows which hash to
// check), which is what makes a per-row salt affordable here and impossible
// for the other two.

describe('hashTillPin / verifyTillPin', () => {
  beforeEach(() => { process.env.TILL_AUTH_PEPPER = 'test-pepper'; });

  it('round-trips a PIN', () => {
    expect(verifyTillPin('1234', hashTillPin('1234'))).toBe(true);
  });

  it('rejects a wrong PIN', () => {
    expect(verifyTillPin('1235', hashTillPin('1234'))).toBe(false);
  });

  it('salts — the same PIN hashes differently every time', () => {
    // The whole point. Two practices that pick 1234 must not share a
    // digest, and a rainbow table over 10^4 must not be reusable.
    const a = hashTillPin('1234');
    const b = hashTillPin('1234');
    expect(a).not.toBe(b);
    expect(verifyTillPin('1234', a)).toBe(true);
    expect(verifyTillPin('1234', b)).toBe(true);
  });

  it('records its parameters inline so they can be raised later', () => {
    expect(hashTillPin('1234')).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
  });

  it('still accepts a PIN stored in the legacy format', () => {
    // Every PIN set before this change is a bare SHA-256 digest. Refusing
    // them would lock every practice out of its own till on deploy; they
    // upgrade the next time a manager sets one, which is the only moment
    // the plaintext is ever in hand.
    const legacy = hashTillSecret('4321');
    expect(verifyTillPin('4321', legacy)).toBe(true);
    expect(verifyTillPin('1234', legacy)).toBe(false);
  });

  it('fails closed on a missing or malformed stored value', () => {
    // A PIN check is an authentication decision: "the stored hash looks
    // wrong" has to behave like any other mismatch, not throw.
    expect(verifyTillPin('1234', null)).toBe(false);
    expect(verifyTillPin('1234', '')).toBe(false);
    expect(verifyTillPin('1234', 'scrypt$notanumber$8$1$aaaa$bbbb')).toBe(false);
    expect(verifyTillPin('1234', 'scrypt$16384$8$1')).toBe(false);
    expect(verifyTillPin('1234', 'scrypt$16384$8$1$$')).toBe(false);
  });

  it('is pepper-bound like the other two', () => {
    const stored = hashTillPin('1234');
    process.env.TILL_AUTH_PEPPER = 'different-pepper';
    expect(verifyTillPin('1234', stored)).toBe(false);
  });
});

describe('requireUnlockedDevice — no_device / revoked', () => {
  it('rejects an empty secret without querying', async () => {
    const result = await requireUnlockedDevice('');
    expect(result).toEqual({ ok: false, code: 'no_device', error: expect.any(String) });
  });

  it('rejects a secret matching no row', async () => {
    deviceRow = null;
    const result = await requireUnlockedDevice('some-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_device');
  });

  it('rejects a revoked device even if otherwise unlocked+active', async () => {
    deviceRow = {
      id: 'd1', practice_id: 'p1', revoked_at: new Date().toISOString(),
      unlocked_at: new Date().toISOString(), last_activity_at: new Date().toISOString(),
    };
    const result = await requireUnlockedDevice('secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('revoked');
    // No last_activity_at refresh for a revoked device.
    expect(updates.length).toBe(0);
  });
});

describe('requireUnlockedDevice — locked (never unlocked / stale day / idle)', () => {
  it('rejects a device that has never been unlocked', async () => {
    deviceRow = { id: 'd1', practice_id: 'p1', revoked_at: null, unlocked_at: null, last_activity_at: null };
    const result = await requireUnlockedDevice('secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('locked');
  });

  it('rejects a device unlocked on a PREVIOUS calendar day, even with recent activity', async () => {
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000); // safely a different UTC day
    deviceRow = {
      id: 'd1', practice_id: 'p1', revoked_at: null,
      unlocked_at: yesterday.toISOString(),
      last_activity_at: new Date().toISOString(), // "active" 1 second ago
    };
    const result = await requireUnlockedDevice('secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('locked');
  });

  it('rejects a device idle for longer than the timeout, even unlocked today', async () => {
    const now = new Date();
    deviceRow = {
      id: 'd1', practice_id: 'p1', revoked_at: null,
      unlocked_at: now.toISOString(),
      last_activity_at: new Date(now.getTime() - TILL_IDLE_TIMEOUT_MS - 1000).toISOString(),
    };
    const result = await requireUnlockedDevice('secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('locked');
  });

  it('accepts a device idle for just UNDER the timeout', async () => {
    const now = new Date();
    deviceRow = {
      id: 'd1', practice_id: 'p1', revoked_at: null,
      unlocked_at: now.toISOString(),
      last_activity_at: new Date(now.getTime() - TILL_IDLE_TIMEOUT_MS + 5000).toISOString(),
    };
    const result = await requireUnlockedDevice('secret');
    expect(result.ok).toBe(true);
  });
});

describe('requireUnlockedDevice — success refreshes last_activity_at', () => {
  it('returns ok + refreshes the sliding idle window on every successful check', async () => {
    const now = new Date();
    deviceRow = {
      id: 'd1', practice_id: 'p1', revoked_at: null,
      unlocked_at: now.toISOString(), last_activity_at: now.toISOString(),
    };
    const result = await requireUnlockedDevice('secret');
    expect(result).toEqual({ ok: true, practiceId: 'p1', deviceId: 'd1' });
    expect(updates.length).toBe(1);
    expect(updates[0]).toHaveProperty('last_activity_at');
  });
});
