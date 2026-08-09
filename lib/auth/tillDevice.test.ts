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

import { hashTillSecret, requireUnlockedDevice, TILL_IDLE_TIMEOUT_MS } from './tillDevice';

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
