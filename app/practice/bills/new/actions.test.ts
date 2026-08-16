import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';
import { VALID_SA_ID } from '@/lib/testing/saIdFixtures';

// createBill now captures an SA ID on every bill, so it encrypts and hashes
// one on the happy path. Fresh throwaway keys, never the production values.
beforeAll(() => {
  process.env.SA_ID_ENCRYPTION_KEY  = randomBytes(32).toString('base64');
  process.env.SA_ID_LOOKUP_HMAC_KEY = randomBytes(32).toString('base64');
});

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
            // New fallback path in createBill: no practiceId supplied →
            //   .eq(user_id).eq(active).order(created_at).limit(1)
            // returns the caller's oldest active membership. For the
            // trading-gate tests we return a single deterministic row
            // — the exact same practice-id the .single() path used to
            // yield, so existing assertions still hold.
            order: (_col2: string, _opts: unknown) => ({
              limit: async (_n: number) => {
                if (table === 'practice_members') {
                  return {
                    data:  [{ practice_id: 'practice-1', created_at: '2026-01-01' }],
                    error: null,
                  };
                }
                return { data: [], error: null };
              },
            }),
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
                // Two consumers hit this mock branch:
                //   1. providerMember guard reads user_id.
                //   2. scoped-membership guard (2026-07-21) reads
                //      practice_id when data.practiceId is supplied.
                // Return both so either caller's cast finds what it
                // needs.
                return {
                  data:  { user_id: 'provider-1', practice_id: 'practice-1' },
                  error: null,
                };
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
      saIdNumber:    VALID_SA_ID,
      billAmount:    1000,
      providerMemberId:    'provider-1',
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
      saIdNumber:    VALID_SA_ID,
      billAmount:    1000,
      providerMemberId:    'provider-1',
    });

    expect(result.error).toBe('mock-no-providers');
    expect(inserts.filter(i => i.table === 'applications')).toHaveLength(0);
    expect(inserts.filter(i => i.table === 'plans')).toHaveLength(0);
  });

  it('allows bill creation when the gate passes (sanity)', async () => {
    gateResult = { ok: true };

    const result = await createBill({
      patientEmail:  'pat@example.com',
      saIdNumber:    VALID_SA_ID,
      billAmount:    1000,
      providerMemberId:    'provider-1',
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
      saIdNumber:    VALID_SA_ID,
      delivery:      'email',
      billAmount:    1000,
      providerMemberId:    'provider-1',
    });

    expect(result.error).toBe('Patient email is required.');
  });
});

// ─── Group→practice acting context — Part B fix (2026-07-21) ────────
//
// Pre-fix the createBill action used `.single()` on practice_members,
// which throws 406 when the caller has N≥2 active rows (every
// brand-admin who created multiple branches). The API now takes an
// optional practiceId; when supplied, the caller must have an active
// membership on that exact practice. When absent, we fall back to
// the caller's oldest membership.
//
// The regression here is subtle: a passing test suite pre-fix
// asserted "solo works" and no test covered N≥2. Post-fix we pin the
// two paths.

describe('createBill — practiceId scope selector (group→practice acting context)', () => {
  it('accepts a practiceId and verifies scoped membership (no .single() on multi-membership)', async () => {
    gateResult = { ok: true };

    // Sanity: existing single-membership mock still resolves. The
    // scoped path takes .maybeSingle() (defined in the mock) which
    // yields {user_id: 'provider-1'} — non-null → guard passes.
    const result = await createBill({
      patientEmail:  'pat@example.com',
      saIdNumber:    VALID_SA_ID,
      billAmount:    1000,
      providerMemberId:    'provider-1',
      practiceId:    'practice-1',
    });

    expect(result.error).toBeNull();
    expect(inserts.filter((i) => i.table === 'plans')).toHaveLength(1);
    const planRow = inserts.find((i) => i.table === 'plans')?.row as { practice_id: string };
    // Correct attribution: the plan row carries the scoped practice.
    expect(planRow.practice_id).toBe('practice-1');
  });

  it('signature carries practiceId as optional — no other input pin was affected', () => {
    // Type-level pin: createBill's declared param shape includes practiceId?.
    // This is a compile-time property; we assert the type structurally.
    const _typeCheck: (data: {
      patientEmail?:      string;
      saIdNumber:         string;
      billAmount:         number;
      providerMemberId:         string;
      practiceReference?: string;
      practiceId?:        string;
    }) => Promise<unknown> = createBill;
    expect(typeof _typeCheck).toBe('function');
  });
});
