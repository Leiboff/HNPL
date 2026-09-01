import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Tests for selfSettleEntirePlan — single-charge settlement-row model ─
//
// Peach edition. The action calls the claim_plan_for_settlement RPC
// (migration 0058) which atomically snapshots + claims every eligible
// instalment AND inserts the settlement payment row. The action then
// fires ONE Peach MIT charge against the settlement row's reference.
// The webhook (tested elsewhere) closes the loop on payment success
// by fanning out 'collected' to the covered instalments.

const chargeSavedCardSpy = vi.fn();
vi.mock('@/lib/payments/provider', () => ({
  getPaymentProvider: () => ({
    chargeSavedCard: (...args: unknown[]) => chargeSavedCardSpy(...args),
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Session client — only used for auth.getUser in this action.
const sessionUser: { value: { id: string } | null } = { value: null };
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: sessionUser.value }, error: null }),
    },
  })),
}));

// Service-role client stubs — same shape as before, but the plans
// column is now peach_registration_id.
type RpcResult = { ok: boolean; error?: string; settlement_id?: string; amount_cents?: number; covered_count?: number };
const rpcResults: { current: RpcResult } = {
  current: { ok: false, error: 'unhandled' },
};
const dbState: {
  plans:    Array<{ id: string; patient_id: string; peach_registration_id: string | null }>;
  profiles: Array<{ id: string; email: string }>;
} = { plans: [], profiles: [] };
const writes: { table: string; op: 'insert' | 'update'; row: unknown }[] = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: vi.fn(async (_name: string, _args: unknown) => ({ data: rpcResults.current, error: null })),
    from(table: string) {
      function selectChain() {
        const filters: Array<(row: Record<string, unknown>) => boolean> = [];
        const builder = {
          eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
          maybeSingle: async () => {
            const rows = (dbState as unknown as Record<string, Record<string, unknown>[]>)[table] ?? [];
            return { data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null };
          },
          single: async () => {
            const rows = (dbState as unknown as Record<string, Record<string, unknown>[]>)[table] ?? [];
            return { data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null };
          },
        };
        return builder;
      }
      return {
        select: selectChain,
        // An update chain that is thenable at every link, so a call site
        // may add as many .eq() filters as the write needs. It used to end
        // after exactly one, which meant adding a second guard to a
        // production write broke the stub rather than the assertion — a
        // test that constrains the shape of a query instead of its effect.
        update: (row: unknown) => {
          let recorded = false;
          const record = () => {
            if (!recorded) { writes.push({ table, op: 'update', row }); recorded = true; }
            return Promise.resolve({ data: null, error: null });
          };
          const chain: Record<string, unknown> = {
            eq:  () => chain,
            in:  () => chain,
            neq: () => chain,
            select: () => record(),
            then: (resolve: (v: unknown) => unknown) => record().then(resolve),
          };
          return chain;
        },
        insert: (row: unknown) => {
          writes.push({ table, op: 'insert', row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  })),
}));

function stubProviderSuccess() {
  chargeSavedCardSpy.mockResolvedValue({
    status:            'success',
    providerPaymentId: 'peach-abc',
    resultCode:        '000.100.110',
  });
}

beforeEach(() => {
  chargeSavedCardSpy.mockReset();
  sessionUser.value = { id: 'user-1' };
  dbState.plans     = [{ id: 'plan-1', patient_id: 'user-1', peach_registration_id: 'REG_ABC' }];
  dbState.profiles  = [{ id: 'user-1', email: 'u@example.com' }];
  writes.length = 0;
  rpcResults.current = { ok: false, error: 'unhandled' };
  process.env.NEXT_PUBLIC_SUPABASE_URL  = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
});

import { selfSettleEntirePlan } from './settle-actions';

describe('selfSettleEntirePlan — auth + RPC outcomes', () => {
  it('rejects an unauthenticated caller (no Peach call)', async () => {
    sessionUser.value = null;
    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('unauthorized');
    expect(chargeSavedCardSpy).not.toHaveBeenCalled();
  });

  it('returns nothing_to_settle when the RPC reports none eligible', async () => {
    rpcResults.current = { ok: false, error: 'nothing_to_settle' };
    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('nothing_to_settle');
    expect(chargeSavedCardSpy).not.toHaveBeenCalled();
  });

  it('returns race_lost when the RPC reports a partial-claim revert', async () => {
    rpcResults.current = { ok: false, error: 'race_lost' };
    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('race_lost');
    expect(chargeSavedCardSpy).not.toHaveBeenCalled();
  });

  it('returns plan_not_found when the RPC reports ownership / lookup failure', async () => {
    rpcResults.current = { ok: false, error: 'plan_not_found' };
    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('plan_not_found');
  });
});

describe('selfSettleEntirePlan — happy path: ONE Peach MIT charge for the SUMMED total', () => {
  it('fires exactly ONE Peach MIT charge with the RPC-returned amount + covered count', async () => {
    rpcResults.current = {
      ok:             true,
      settlement_id:  'aaaa1111-bbbb-2222-cccc-333344445555',
      amount_cents:   75_500,
      covered_count:  3,
    };
    stubProviderSuccess();

    const result = await selfSettleEntirePlan('plan-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('charged');
    expect(result.amountCents).toBe(75_500);
    expect(result.coveredCount).toBe(3);

    expect(chargeSavedCardSpy).toHaveBeenCalledTimes(1);
    const [args] = chargeSavedCardSpy.mock.calls as [[{
      registrationId:        string;
      amountCents:           number;
      merchantTransactionId: string;
      currency:              string;
      standingInstruction:   { mode: string; source: string; type: string };
    }]];
    expect(args[0].registrationId).toBe('REG_ABC');
    expect(args[0].amountCents).toBe(75_500);
    expect(args[0].currency).toBe('ZAR');
    expect(args[0].merchantTransactionId).toMatch(/^bns[a-z0-9]{13}$/);
    expect(args[0].standingInstruction).toEqual({
      mode:   'REPEATED',
      source: 'MIT',
      type:   'UNSCHEDULED',
    });
  });

  it('writes the reference back onto the settlement row before charging', async () => {
    rpcResults.current = { ok: true, settlement_id: 'set-1', amount_cents: 50_000, covered_count: 2 };
    stubProviderSuccess();
    await selfSettleEntirePlan('plan-1');

    const update = writes.find(w => w.table === 'payments' && w.op === 'update');
    expect(update).toBeDefined();
    expect((update!.row as Record<string, unknown>).peach_payment_id).toMatch(/^bns[a-z0-9]{13}$/);
  });
});

describe('selfSettleEntirePlan — precondition failures after a successful claim', () => {
  it('no_registration_id: fails the settlement row, never calls Peach', async () => {
    rpcResults.current = { ok: true, settlement_id: 'set-1', amount_cents: 25_000, covered_count: 1 };
    dbState.plans = [{ id: 'plan-1', patient_id: 'user-1', peach_registration_id: null }];

    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('no_registration_id');
    expect(chargeSavedCardSpy).not.toHaveBeenCalled();

    const failure = writes.find(w =>
      w.table === 'payments' && w.op === 'update' &&
      (w.row as Record<string, unknown>).status === 'failed',
    );
    expect(failure).toBeDefined();
  });

  it('Peach transport error: settlement row stays in processing (no auto-revert)', async () => {
    rpcResults.current = { ok: true, settlement_id: 'set-1', amount_cents: 25_000, covered_count: 1 };
    chargeSavedCardSpy.mockResolvedValue({ status: 'error', resultDescription: 'Peach 502' });

    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('transport_error');

    const failedAfterCharge = writes.filter(w =>
      w.table === 'payments' && w.op === 'update' &&
      (w.row as Record<string, unknown>).status === 'failed' &&
      !(w.row as Record<string, unknown>).peach_payment_id,
    );
    expect(failedAfterCharge).toHaveLength(0);
  });
});
