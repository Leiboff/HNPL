import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';

// ─── issueCounterSession — POS/counter bill issuance ─────────────────
//
// Mirrors app/practice/bills/new/actions.test.ts's mocking pattern for
// createBill (its till-side sibling). The invariant unique to this
// action, beyond the shared trading-gate/scope enforcement: the
// plaintext SA ID must NEVER appear in the returned result — only an
// opaque token. That's the POPIA "till never learns/stores the ID"
// requirement made testable.

// ─── Checksummed SA ID synthesis (mirrors lib/validation/saId.test.ts) ──
// Hand-picking a 13-digit string risks an invalid Luhn checksum, which
// would make every "success path" test fail for the wrong reason. Build
// real, valid IDs the same way that test file does.
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
  // sequence (4) + citizenship (1) + race digit (1) = 6, for a total
  // first12 length of 12 (6 date + 6 here) before the check digit.
  const first12 = `${yy}${mm}${dd}012308`;
  return first12 + synthLuhn(first12);
}

const VALID_SA_ID = synthSaId({ year: 1990, month: 1, day: 1 });
const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

let gateResult: { ok: true } | { ok: false; reason: string; message: string } = { ok: true };

vi.mock('@/lib/practice/tradingGate', () => ({
  checkTradingGate: vi.fn(async () => gateResult),
}));

function makeSsrClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }),
    },
    from(table: string) {
      const builder: Record<string, unknown> = {};
      builder.insert = (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return Promise.resolve({ data: null, error: null });
      };
      builder.delete = () => ({ eq: () => Promise.resolve({ data: null, error: null }) });
      builder.select = (_cols: string) => {
        function eqStep(_col: string, _val: unknown): unknown {
          return {
            eq: eqStep,
            order: () => ({
              limit: async () => {
                if (table === 'practice_members') {
                  return { data: [{ practice_id: 'practice-1', created_at: '2026-01-01' }], error: null };
                }
                return { data: [], error: null };
              },
            }),
            maybeSingle: async () => {
              if (table === 'practice_members') {
                return { data: { user_id: 'provider-1', practice_id: 'practice-1' }, error: null };
              }
              return { data: null, error: null };
            },
          };
        }
        return { eq: eqStep };
      };
      return builder;
    },
    rpc: async () => ({ data: 'INV-0001', error: null }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSsrClient()),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => makeSsrClient()),
}));

beforeEach(() => {
  inserts.length = 0;
  gateResult = { ok: true };
  process.env.SA_ID_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

import { issueCounterSession } from './actions';

describe('issueCounterSession — input validation', () => {
  it('rejects an out-of-range bill amount', async () => {
    const result = await issueCounterSession({
      billAmount: -5,
      saIdNumber: VALID_SA_ID,
      providerId: 'provider-1',
    });
    expect(result.error).toMatch(/between/);
    expect(inserts).toHaveLength(0);
  });

  it('rejects an invalid SA ID', async () => {
    const result = await issueCounterSession({
      billAmount: 1000,
      saIdNumber: '123',
      providerId: 'provider-1',
    });
    expect(result.error).toMatch(/valid 13-digit SA ID/);
    expect(inserts).toHaveLength(0);
  });

  it('rejects an under-18 SA ID', async () => {
    const now = new Date();
    const minorId = synthSaId({ year: now.getFullYear() - 10, month: 1, day: 1 });
    const result = await issueCounterSession({
      billAmount: 1000,
      saIdNumber: minorId,
      providerId: 'provider-1',
    });
    expect(result.error).toMatch(/18 or older/);
    expect(inserts).toHaveLength(0);
  });

  it('rejects a malformed optional cell number without rejecting a blank one', async () => {
    const badCell = await issueCounterSession({
      billAmount: 1000,
      saIdNumber: VALID_SA_ID,
      providerId: 'provider-1',
      cellNumber: 'not-a-number',
    });
    expect(badCell.error).toMatch(/cellphone/);
    expect(inserts).toHaveLength(0);

    const blankCell = await issueCounterSession({
      billAmount: 1000,
      saIdNumber: VALID_SA_ID,
      providerId: 'provider-1',
      cellNumber: '',
    });
    expect(blankCell.error).toBeNull();
  });
});

describe('issueCounterSession — trading gate enforcement', () => {
  it('rejects with the gate message before any insert', async () => {
    gateResult = { ok: false, reason: 'pending_approval', message: 'mock-pending-approval' };
    const result = await issueCounterSession({
      billAmount: 1000,
      saIdNumber: VALID_SA_ID,
      providerId: 'provider-1',
    });
    expect(result.error).toBe('mock-pending-approval');
    expect(inserts).toHaveLength(0);
  });
});

describe('issueCounterSession — success path', () => {
  it('creates applications + plans + checkout_sessions, and returns a token/expiry (never the SA ID)', async () => {
    const result = await issueCounterSession({
      billAmount: 1000,
      saIdNumber: VALID_SA_ID,
      providerId: 'provider-1',
    });

    expect(result.error).toBeNull();
    expect(result.token).toBeTruthy();
    expect(result.expiresAt).toBeTruthy();
    expect(result.planId).toBeTruthy();

    // The plaintext SA ID must never appear anywhere in the response —
    // this is the POPIA "till never learns the ID" property.
    expect(JSON.stringify(result)).not.toContain(VALID_SA_ID);

    expect(inserts.filter(i => i.table === 'applications')).toHaveLength(1);
    expect(inserts.filter(i => i.table === 'plans')).toHaveLength(1);
    const sessionInsert = inserts.find(i => i.table === 'checkout_sessions');
    expect(sessionInsert).toBeTruthy();
    // The stored value is the ENCRYPTED form (v1: prefix), never plaintext.
    expect(sessionInsert!.row.sa_id_number).toMatch(/^v1:/);
    expect(sessionInsert!.row.sa_id_number).not.toBe(VALID_SA_ID);
  });

  it('plans row starts with patient_id null (unresolved until the phone-side checkout)', async () => {
    await issueCounterSession({
      billAmount: 1000,
      saIdNumber: VALID_SA_ID,
      providerId: 'provider-1',
    });
    const planInsert = inserts.find(i => i.table === 'plans');
    expect(planInsert!.row.patient_id).toBeNull();
    expect(planInsert!.row.status).toBe('pending_acceptance');
  });
});
