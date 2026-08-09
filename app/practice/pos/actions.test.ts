import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';

// ─── issueCounterSession — POS/counter bill issuance (device-gated) ────
//
// Post-device-auth: issueCounterSession no longer touches a Supabase
// user session at all — it authenticates via requireUnlockedDevice
// (lib/auth/tillDevice.ts), which resolves practice_id from a
// till_devices row instead of a practice_members row. This mock models
// that table (+ practices, practice_members, applications, plans,
// checkout_sessions) generically by filter, mirroring the pattern in
// lib/payments/activateFirstInstalment.test.ts, since the fixed-shape
// mock this file used pre-device-auth can't express "look up by
// secret_hash" alongside everything else issueCounterSession still does.
//
// The invariant unique to this action, beyond validation/trading-gate/
// device-auth enforcement: the plaintext SA ID must NEVER appear in the
// returned result — only an opaque token. That's the POPIA "till never
// learns/stores the ID" requirement made testable.

function synthLuhn(first12: string): string {
  let sum = 0;
  let doubleIt = true;
  for (let i = first12.length - 1; i >= 0; i--) {
    let d = first12.charCodeAt(i) - 48;
    if (doubleIt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    doubleIt = !doubleIt;
  }
  return String((10 - (sum % 10)) % 10);
}
function synthSaId(parts: { year: number; month: number; day: number }): string {
  const yy = String(parts.year % 100).padStart(2, '0');
  const mm = String(parts.month).padStart(2, '0');
  const dd = String(parts.day).padStart(2, '0');
  const first12 = `${yy}${mm}${dd}012308`;
  return first12 + synthLuhn(first12);
}

const VALID_SA_ID    = synthSaId({ year: 1990, month: 1, day: 1 });
const DEVICE_SECRET  = 'device-secret-under-test';
const DEVICE_ID      = 'device-1';
const PRACTICE_ID    = 'practice-1';

let gateResult: { ok: true } | { ok: false; reason: string; message: string } = { ok: true };

vi.mock('@/lib/practice/tradingGate', () => ({
  checkTradingGate: vi.fn(async () => gateResult),
}));

type Row = Record<string, unknown>;
const inserts: Array<{ table: string; row: Row }> = [];
let state: Record<string, Row[]> = {};

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([c, v]) => row[c] === v);
}

function makeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b; };
      b.maybeSingle = async () => ({
        data: (state[table] ?? []).find((r) => matches(r, filters)) ?? null,
        error: null,
      });
      b.single = b.maybeSingle;
      b.insert = (row: Row) => {
        inserts.push({ table, row });
        (state[table] ??= []).push({ ...row });
        return Promise.resolve({ data: null, error: null });
      };
      b.update = (patch: Row) => {
        const updB: Record<string, unknown> = {};
        const upFilters: Array<[string, unknown]> = [...filters];
        updB.eq = (c: string, v: unknown) => { upFilters.push([c, v]); return updB; };
        const finalize = () => {
          for (const r of (state[table] ?? [])) {
            if (matches(r, upFilters)) Object.assign(r, patch);
          }
          return { data: null, error: null };
        };
        Object.assign(updB, { then: (resolve: (v: unknown) => void) => resolve(finalize()) });
        return updB;
      };
      b.delete = () => ({ eq: () => Promise.resolve({ data: null, error: null }) });
      return b;
    },
    rpc: async (name: string) => {
      if (name === 'next_invoice_number') return { data: 'INV-0001', error: null };
      return { data: null, error: null };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeClient()),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => makeClient()),
}));

beforeEach(async () => {
  inserts.length = 0;
  gateResult = { ok: true };
  process.env.SA_ID_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.TILL_AUTH_PEPPER    = 'test-pepper';

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
    practice_members: [
      { user_id: 'provider-1', practice_id: PRACTICE_ID, active: true, role: 'provider' },
    ],
  };
});

import { issueCounterSession } from './actions';

function issueArgs(overrides: Partial<Parameters<typeof issueCounterSession>[0]> = {}) {
  return {
    deviceSecret: DEVICE_SECRET,
    billAmount:   1000,
    saIdNumber:   VALID_SA_ID,
    providerId:   'provider-1',
    ...overrides,
  };
}

describe('issueCounterSession — device auth', () => {
  it('rejects with no device secret', async () => {
    const result = await issueCounterSession(issueArgs({ deviceSecret: '' }));
    expect(result.error).toBeTruthy();
    expect(inserts).toHaveLength(0);
  });

  it('rejects an unrecognized device secret', async () => {
    const result = await issueCounterSession(issueArgs({ deviceSecret: 'not-the-real-secret' }));
    expect(result.error).toMatch(/not registered/);
    expect(inserts).toHaveLength(0);
  });

  it('rejects a revoked device even though it looks unlocked', async () => {
    state.till_devices[0].revoked_at = new Date().toISOString();
    const result = await issueCounterSession(issueArgs());
    expect(result.error).toMatch(/revoked/);
    expect(inserts).toHaveLength(0);
  });

  it('rejects a device that has never been unlocked', async () => {
    state.till_devices[0].unlocked_at = null;
    const result = await issueCounterSession(issueArgs());
    expect(result.error).toMatch(/locked/);
    expect(inserts).toHaveLength(0);
  });
});

describe('issueCounterSession — input validation', () => {
  it('rejects an out-of-range bill amount', async () => {
    const result = await issueCounterSession(issueArgs({ billAmount: -5 }));
    expect(result.error).toMatch(/between/);
    expect(inserts).toHaveLength(0);
  });

  it('rejects an invalid SA ID', async () => {
    const result = await issueCounterSession(issueArgs({ saIdNumber: '123' }));
    expect(result.error).toMatch(/valid 13-digit SA ID/);
    expect(inserts).toHaveLength(0);
  });

  it('rejects an under-18 SA ID', async () => {
    const now = new Date();
    const minorId = synthSaId({ year: now.getFullYear() - 10, month: 1, day: 1 });
    const result = await issueCounterSession(issueArgs({ saIdNumber: minorId }));
    expect(result.error).toMatch(/18 or older/);
    expect(inserts).toHaveLength(0);
  });

  it('rejects a malformed optional cell number without rejecting a blank one', async () => {
    const badCell = await issueCounterSession(issueArgs({ cellNumber: 'not-a-number' }));
    expect(badCell.error).toMatch(/cellphone/);
    expect(inserts).toHaveLength(0);

    const blankCell = await issueCounterSession(issueArgs({ cellNumber: '' }));
    expect(blankCell.error).toBeNull();
  });
});

describe('issueCounterSession — trading gate enforcement', () => {
  it('rejects with the gate message before any insert', async () => {
    gateResult = { ok: false, reason: 'pending_approval', message: 'mock-pending-approval' };
    const result = await issueCounterSession(issueArgs());
    expect(result.error).toBe('mock-pending-approval');
    expect(inserts).toHaveLength(0);
  });
});

describe('issueCounterSession — success path', () => {
  it('creates applications + plans + checkout_sessions, and returns a token/expiry (never the SA ID)', async () => {
    const result = await issueCounterSession(issueArgs());

    expect(result.error).toBeNull();
    expect(result.token).toBeTruthy();
    expect(result.expiresAt).toBeTruthy();
    expect(result.planId).toBeTruthy();

    // The plaintext SA ID must never appear anywhere in the response —
    // this is the POPIA "till never learns the ID" property.
    expect(JSON.stringify(result)).not.toContain(VALID_SA_ID);
    // Nor the device secret.
    expect(JSON.stringify(result)).not.toContain(DEVICE_SECRET);

    expect(inserts.filter(i => i.table === 'applications')).toHaveLength(1);
    expect(inserts.filter(i => i.table === 'plans')).toHaveLength(1);
    const sessionInsert = inserts.find(i => i.table === 'checkout_sessions');
    expect(sessionInsert).toBeTruthy();
    expect(sessionInsert!.row.sa_id_number).toMatch(/^v1:/);
    expect(sessionInsert!.row.sa_id_number).not.toBe(VALID_SA_ID);
    // Audit trail (Build D): the issuing device is stamped on the row.
    expect(sessionInsert!.row.issued_via_device_id).toBe(DEVICE_ID);
  });

  it('plans row starts with patient_id null (unresolved until the phone-side checkout)', async () => {
    await issueCounterSession(issueArgs());
    const planInsert = inserts.find(i => i.table === 'plans');
    expect(planInsert!.row.patient_id).toBeNull();
    expect(planInsert!.row.status).toBe('pending_acceptance');
  });

  it('refreshes the device last_activity_at as part of a successful issuance', async () => {
    state.till_devices[0].last_activity_at = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    const before = state.till_devices[0].last_activity_at as string;
    await issueCounterSession(issueArgs());
    expect(state.till_devices[0].last_activity_at).not.toBe(before);
  });
});
