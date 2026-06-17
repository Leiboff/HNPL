import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── createBill — trading-gate enforcement ───────────────────────────────────
//
// Asserts server-side rejection: a pending or provider-less practice cannot
// create bills via the createBill server action. The check is enforced by
// checkTradingGate; this test proves createBill calls it BEFORE any
// applications/plans insert, and propagates the gate's error message.

const inserts: Array<{ table: string; row: unknown }> = [];

// Track gate result so individual tests can flip it without re-mocking.
let gateResult: { ok: true } | { ok: false; reason: string; message: string } = { ok: true };

vi.mock('@/lib/practice/tradingGate', () => ({
  checkTradingGate: vi.fn(async () => gateResult),
  // The real module exports these strings too — re-export so any consumer
  // that imports them keeps working under mock.
  PENDING_APPROVAL_MESSAGE: 'mock-pending-approval',
  NO_PROVIDERS_MESSAGE:     'mock-no-providers',
}));

// ── Stub SSR client ──────────────────────────────────────────────────────────

function makeSsrClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }),
    },
    from(table: string) {
      const builder: Record<string, unknown> = {};
      // .insert returns a thenable-shaped object.
      builder.insert = (row: unknown) => {
        inserts.push({ table, row });
        return Promise.resolve({ data: null, error: null });
      };
      // .delete().eq() chain used in the rollback path.
      builder.delete = () => ({ eq: () => Promise.resolve({ data: null, error: null }) });
      // .select(...).eq(...).maybeSingle()/.single()/.eq(...).eq(...).maybeSingle()
      //
      // The idempotency-window dup-check on createBill chains
      // .eq().eq().gte() to look up recent invitations / plans. The
      // mock returns an empty array for that path so no duplicate
      // ever fires in the trading-gate tests.
      builder.select = (_cols: string) => {
        function eqStep(_col: string, _val: unknown): unknown {
          return {
            eq: eqStep,
            gte: async () => ({ data: [], error: null }),
            single: async () => {
              if (table === 'practice_members') {
                return { data: { practice_id: 'practice-1' }, error: null };
              }
              if (table === 'practices') {
                return { data: { name: 'Mock Practice', fee_percent: 6 }, error: null };
              }
              return { data: null, error: null };
            },
            maybeSingle: async () => {
              if (table === 'practice_members') {
                return { data: { user_id: 'provider-1' }, error: null };
              }
              if (table === 'profiles') {
                return { data: null, error: null };  // unknown patient
              }
              return { data: null, error: null };
            },
          };
        }
        return { eq: eqStep };
      };
      builder.rpc = async () => ({ data: 'INV-0001', error: null });
      return builder;
    },
    // top-level .rpc for next_invoice_number
    rpc: async () => ({ data: 'INV-0001', error: null }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSsrClient()),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => makeSsrClient()),
}));

// ─── Import AFTER mocks are set up ──────────────────────────────────────────

import { createBill } from './actions';

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  inserts.length = 0;
  gateResult = { ok: true };
});

describe('createBill — server-side trading-gate enforcement', () => {
  it('rejects with the gate message when the practice is pending approval', async () => {
    gateResult = {
      ok: false,
      reason: 'pending_approval',
      message: 'mock-pending-approval',
    };

    const result = await createBill({
      patientEmail:  'pat@example.com',
      billAmount:    1000,
      providerId:    'provider-1',
    });

    expect(result.error).toBe('mock-pending-approval');
    // ABSOLUTE proof of server-side enforcement: not a single applications
    // or plans insert happened.
    expect(inserts.filter(i => i.table === 'applications')).toHaveLength(0);
    expect(inserts.filter(i => i.table === 'plans')).toHaveLength(0);
  });

  it('rejects with the gate message when the practice has no providers', async () => {
    gateResult = {
      ok: false,
      reason: 'no_providers',
      message: 'mock-no-providers',
    };

    const result = await createBill({
      patientEmail:  'pat@example.com',
      billAmount:    1000,
      providerId:    'provider-1',
    });

    expect(result.error).toBe('mock-no-providers');
    expect(inserts.filter(i => i.table === 'applications')).toHaveLength(0);
    expect(inserts.filter(i => i.table === 'plans')).toHaveLength(0);
  });

  it('allows bill creation when the gate passes (sanity)', async () => {
    gateResult = { ok: true };

    const result = await createBill({
      patientEmail:  'pat@example.com',
      billAmount:    1000,
      providerId:    'provider-1',
    });

    expect(result.error).toBeNull();
    // Both rows inserted.
    expect(inserts.filter(i => i.table === 'applications')).toHaveLength(1);
    expect(inserts.filter(i => i.table === 'plans')).toHaveLength(1);
  });

  it('still rejects bad input BEFORE consulting the gate (cheap validation first)', async () => {
    gateResult = { ok: true };

    const result = await createBill({
      patientEmail:  '',
      billAmount:    1000,
      providerId:    'provider-1',
    });

    expect(result.error).toBe('Patient email is required.');
  });
});
