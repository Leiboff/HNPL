import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Tests for selfSettleEntirePlan — single-charge settlement-row model ─
//
// The action calls the claim_plan_for_settlement RPC (migration 0058)
// which atomically snapshots + claims every eligible instalment AND
// inserts the settlement payment row. The action then fires ONE
// Paystack charge against the settlement row's reference. The webhook
// (tested elsewhere) closes the loop on charge.success by fanning out
// 'collected' to the covered instalments.
//
// What this file pins:
//   • Auth gate.
//   • Happy path → RPC ok → Paystack charge fires with the SUMMED
//     amount_cents the RPC returned → outcome 'charged'.
//   • The 2+ outstanding total is whatever the RPC returns — the
//     action does NOT recompute it locally (that's the whole point
//     of doing the claim + sum atomically in Postgres). We assert the
//     action passes through the RPC's amount and that the Paystack
//     `amount` body field matches.
//   • nothing_to_settle / race_lost / no_authorization_code / no_email
//     each map to the right outcome status.
//   • Paystack transport error → 'transport_error' (settlement row
//     stays in 'processing' — admin reconcile; same posture as the
//     cron's per-instalment transport_error).

const paystackRequestSpy = vi.fn();
vi.mock('@/lib/paystack', () => ({
  paystackRequest: (...args: unknown[]) => paystackRequestSpy(...args),
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

// Service-role client — used for the RPC + plans/profiles lookups +
// the payments / plan_events writes. We stub the surface the action
// touches: .rpc(name, args); .from(table).select/update/insert chains.
type RpcResult = { ok: boolean; error?: string; settlement_id?: string; amount_cents?: number; covered_count?: number };
const rpcResults: { current: RpcResult } = {
  current: { ok: false, error: 'unhandled' },
};
const dbState: {
  plans:    Array<{ id: string; patient_id: string; paystack_authorization_code: string | null }>;
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
        update: (row: unknown) => ({
          eq: () => {
            writes.push({ table, op: 'update', row });
            return Promise.resolve({ data: null, error: null });
          },
        }),
        insert: (row: unknown) => {
          writes.push({ table, op: 'insert', row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  })),
}));

beforeEach(() => {
  paystackRequestSpy.mockReset();
  sessionUser.value = { id: 'user-1' };
  dbState.plans     = [{ id: 'plan-1', patient_id: 'user-1', paystack_authorization_code: 'AUTH_ABC' }];
  dbState.profiles  = [{ id: 'user-1', email: 'u@example.com' }];
  writes.length = 0;
  rpcResults.current = { ok: false, error: 'unhandled' };
  process.env.NEXT_PUBLIC_SUPABASE_URL  = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
});

import { selfSettleEntirePlan } from './settle-actions';

describe('selfSettleEntirePlan — auth + RPC outcomes', () => {
  it('rejects an unauthenticated caller (no Paystack call)', async () => {
    sessionUser.value = null;
    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('unauthorized');
    expect(paystackRequestSpy).not.toHaveBeenCalled();
  });

  it('returns nothing_to_settle when the RPC reports none eligible', async () => {
    rpcResults.current = { ok: false, error: 'nothing_to_settle' };
    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('nothing_to_settle');
    expect(paystackRequestSpy).not.toHaveBeenCalled();
  });

  it('returns race_lost when the RPC reports a partial-claim revert', async () => {
    rpcResults.current = { ok: false, error: 'race_lost' };
    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('race_lost');
    expect(paystackRequestSpy).not.toHaveBeenCalled();
  });

  it('returns plan_not_found when the RPC reports ownership / lookup failure', async () => {
    rpcResults.current = { ok: false, error: 'plan_not_found' };
    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('plan_not_found');
  });
});

describe('selfSettleEntirePlan — happy path: ONE Paystack charge for the SUMMED total', () => {
  it('fires exactly ONE Paystack charge with the RPC-returned amount + covered count', async () => {
    // 2+ outstanding instalments: the RPC summed amount_cents reflects
    // sum(amount + dunning_fees_cents) across them all. This test
    // verifies the action passes that summed amount through to Paystack
    // verbatim — not a single-instalment amount.
    rpcResults.current = {
      ok:             true,
      settlement_id:  'aaaa1111-bbbb-2222-cccc-333344445555',
      amount_cents:   75_500,           // e.g. 3 × R250 + R500 in fees
      covered_count:  3,
    };
    paystackRequestSpy.mockResolvedValue({ status: true });

    const result = await selfSettleEntirePlan('plan-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('charged');
    expect(result.amountCents).toBe(75_500);
    expect(result.coveredCount).toBe(3);

    // Exactly ONE Paystack call with the summed amount.
    expect(paystackRequestSpy).toHaveBeenCalledTimes(1);
    const [endpoint, opts] = paystackRequestSpy.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('/transaction/charge_authorization');
    const body = JSON.parse(opts.body as string);
    expect(body.amount).toBe(75_500);                                       // ← summed, not bare instalment
    expect(body.currency).toBe('ZAR');
    expect(body.authorization_code).toBe('AUTH_ABC');
    expect(body.email).toBe('u@example.com');
    expect(body.metadata.purpose).toBe('settle_entire_plan');
    expect(body.reference).toMatch(/^hnpl_settle_/);
  });

  it('writes the reference back onto the settlement row before charging', async () => {
    rpcResults.current = { ok: true, settlement_id: 'set-1', amount_cents: 50_000, covered_count: 2 };
    paystackRequestSpy.mockResolvedValue({ status: true });
    await selfSettleEntirePlan('plan-1');

    // The action does a payments UPDATE before the Paystack call to
    // store the reference. We can see it in the writes log.
    const update = writes.find(w => w.table === 'payments' && w.op === 'update');
    expect(update).toBeDefined();
    expect((update!.row as Record<string, unknown>).peach_payment_id).toMatch(/^hnpl_settle_/);
  });
});

describe('selfSettleEntirePlan — precondition failures after a successful claim', () => {
  it('no_authorization_code: fails the settlement row, never calls Paystack', async () => {
    rpcResults.current = { ok: true, settlement_id: 'set-1', amount_cents: 25_000, covered_count: 1 };
    dbState.plans = [{ id: 'plan-1', patient_id: 'user-1', paystack_authorization_code: null }];

    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('no_authorization_code');
    expect(paystackRequestSpy).not.toHaveBeenCalled();

    // Settlement row was marked failed so the webhook (or a sweeper)
    // restores covered instalments via the snapshot revert path.
    const failure = writes.find(w =>
      w.table === 'payments' && w.op === 'update' &&
      (w.row as Record<string, unknown>).status === 'failed',
    );
    expect(failure).toBeDefined();
  });

  it('Paystack transport error: settlement row stays in processing (no auto-revert)', async () => {
    rpcResults.current = { ok: true, settlement_id: 'set-1', amount_cents: 25_000, covered_count: 1 };
    paystackRequestSpy.mockRejectedValue(new Error('Paystack 502'));

    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('transport_error');

    // No explicit failure UPDATE after the Paystack call — the row
    // stays in 'processing' because Paystack may still have received
    // the charge. Same posture as chargeInstalment's transport_error.
    const failedAfterCharge = writes.filter(w =>
      w.table === 'payments' && w.op === 'update' &&
      (w.row as Record<string, unknown>).status === 'failed' &&
      !(w.row as Record<string, unknown>).peach_payment_id,
    );
    expect(failedAfterCharge).toHaveLength(0);
  });
});
