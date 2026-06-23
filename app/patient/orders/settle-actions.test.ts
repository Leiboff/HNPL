import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Tests for selfSettleEntirePlan ─────────────────────────────────────
//
// The action loops over every outstanding instalment on a plan and
// routes each through the SAME attemptChargeInstalment(selfSettle:true)
// atomic claim used by the single-row self-settle action. That means:
//   • idempotency comes for free from the per-row claim;
//   • a concurrent cron attempt on any one row resolves at THAT row's
//     atomic UPDATE — exactly one charge per instalment;
//   • a double-tap is safe — the second pass sees every row already
//     in 'processing' and returns claim_lost.
//
// These tests verify those properties at the action level by stubbing
// the lower-level helpers.

const attemptChargeInstalmentSpy = vi.fn();

vi.mock('@/lib/payments/chargeInstalment', () => ({
  attemptChargeInstalment: (...args: unknown[]) => attemptChargeInstalmentSpy(...args),
  MAX_ATTEMPTS: 6,
}));

// next/cache no-op
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// Session client — drives the auth + ownership checks. Returns the
// stubbed user and plan/payments rows by table.
const sessionState: {
  user:     { id: string } | null;
  plans:    Array<{ id: string; patient_id: string; status: string }>;
  payments: Array<{ id: string; status: string; instalment_number: number; amount: number; dunning_fees_cents: number; plan_id: string }>;
} = { user: null, plans: [], payments: [] };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({
        data: { user: sessionState.user },
        error: null,
      }),
    },
    from(table: string) {
      function selectChain() {
        const filters: Array<(row: Record<string, unknown>) => boolean> = [];
        const builder = {
          eq(col: string, val: unknown) {
            filters.push((r) => r[col] === val);
            return builder;
          },
          in(col: string, vals: unknown[]) {
            filters.push((r) => vals.includes(r[col]));
            return builder;
          },
          order() { return builder; },
          maybeSingle: async () => {
            const rows = (sessionState as unknown as Record<string, Record<string, unknown>[]>)[table] ?? [];
            const found = rows.find((r) => filters.every((f) => f(r)));
            return { data: found ?? null, error: null };
          },
          then: (resolve: (v: unknown) => void) => {
            const rows = (sessionState as unknown as Record<string, Record<string, unknown>[]>)[table] ?? [];
            const found = rows.filter((r) => filters.every((f) => f(r)));
            resolve({ data: found, error: null });
          },
        };
        return builder;
      }
      return { select: selectChain };
    },
  })),
}));

// Service-role client — used to write plan_events after each successful
// claim. We collect the inserts to assert on them.
const planEventInserts: Array<Record<string, unknown>> = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          if (table === 'plan_events') planEventInserts.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  })),
}));

beforeEach(() => {
  attemptChargeInstalmentSpy.mockReset();
  planEventInserts.length = 0;
  sessionState.user     = { id: 'user-1' };
  sessionState.plans    = [{ id: 'plan-1', patient_id: 'user-1', status: 'active' }];
  sessionState.payments = [];
  process.env.NEXT_PUBLIC_SUPABASE_URL  = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
});

import { selfSettleEntirePlan } from './settle-actions';

describe('selfSettleEntirePlan — auth + ownership gates', () => {
  it('rejects an unauthenticated caller', async () => {
    sessionState.user = null;
    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('unauthorized');
    expect(attemptChargeInstalmentSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-existent plan', async () => {
    sessionState.plans = [];
    const result = await selfSettleEntirePlan('plan-missing');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('plan_not_found');
  });

  it("rejects a plan that doesn't belong to the caller", async () => {
    sessionState.plans = [{ id: 'plan-1', patient_id: 'other-user', status: 'active' }];
    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('unauthorized');
  });
});

describe('selfSettleEntirePlan — happy path', () => {
  it('settles every outstanding instalment, returns per-row results + total', async () => {
    sessionState.payments = [
      { id: 'pay-1', plan_id: 'plan-1', status: 'scheduled', instalment_number: 2, amount: 250, dunning_fees_cents: 0 },
      { id: 'pay-2', plan_id: 'plan-1', status: 'failed',    instalment_number: 3, amount: 250, dunning_fees_cents: 10_000 },
    ];
    attemptChargeInstalmentSpy
      .mockResolvedValueOnce({ kind: 'charged', paymentId: 'pay-1', reference: 'r1', attemptNumber: 1, amountChargedCents: 25_000 })
      .mockResolvedValueOnce({ kind: 'charged', paymentId: 'pay-2', reference: 'r2', attemptNumber: 2, amountChargedCents: 35_000 });

    const result = await selfSettleEntirePlan('plan-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('settled_all');
    expect(result.totalChargedCents).toBe(60_000);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].outcome).toBe('charged');
    expect(result.results[1].outcome).toBe('charged');

    // Each successful charge writes a plan_events row.
    expect(planEventInserts.length).toBe(2);
    for (const ev of planEventInserts) {
      expect(ev.event_type).toBe('instalment_self_settled');
      const payload = ev.payload as Record<string, unknown>;
      expect(payload.via_settle_all).toBe(true);
    }
  });

  it('reports nothing_to_settle when no outstanding instalments', async () => {
    sessionState.payments = []; // all collected → none selected by the in() filter
    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('nothing_to_settle');
    expect(attemptChargeInstalmentSpy).not.toHaveBeenCalled();
  });
});

describe('selfSettleEntirePlan — idempotency / race resilience', () => {
  it('double-tap: second pass sees every row in-progress → returns already_in_progress', async () => {
    sessionState.payments = [
      { id: 'pay-1', plan_id: 'plan-1', status: 'scheduled', instalment_number: 2, amount: 250, dunning_fees_cents: 0 },
      { id: 'pay-2', plan_id: 'plan-1', status: 'failed',    instalment_number: 3, amount: 250, dunning_fees_cents: 10_000 },
    ];
    attemptChargeInstalmentSpy
      .mockResolvedValueOnce({ kind: 'claim_lost', paymentId: 'pay-1', reason: 'already_claimed' })
      .mockResolvedValueOnce({ kind: 'claim_lost', paymentId: 'pay-2', reason: 'already_claimed' });

    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalChargedCents).toBe(0);
    expect(result.results.every(r => r.outcome === 'already_in_progress')).toBe(true);
    expect(planEventInserts).toHaveLength(0);
  });

  it('partial success: one transport_error mid-loop, others still charge', async () => {
    sessionState.payments = [
      { id: 'pay-1', plan_id: 'plan-1', status: 'scheduled', instalment_number: 2, amount: 250, dunning_fees_cents: 0 },
      { id: 'pay-2', plan_id: 'plan-1', status: 'failed',    instalment_number: 3, amount: 250, dunning_fees_cents: 10_000 },
      { id: 'pay-3', plan_id: 'plan-1', status: 'scheduled', instalment_number: 4, amount: 250, dunning_fees_cents: 0 },
    ];
    attemptChargeInstalmentSpy
      .mockResolvedValueOnce({ kind: 'charged',         paymentId: 'pay-1', reference: 'r1', attemptNumber: 1, amountChargedCents: 25_000 })
      .mockResolvedValueOnce({ kind: 'transport_error', paymentId: 'pay-2', reference: 'r2', error: 'Paystack 502' })
      .mockResolvedValueOnce({ kind: 'charged',         paymentId: 'pay-3', reference: 'r3', attemptNumber: 1, amountChargedCents: 25_000 });

    const result = await selfSettleEntirePlan('plan-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalChargedCents).toBe(50_000);            // two charged
    const byOutcome = result.results.map(r => r.outcome);
    expect(byOutcome).toEqual(['charged', 'transport_error', 'charged']);
    // Only the two successful claims should have written audit rows.
    expect(planEventInserts).toHaveLength(2);
  });
});
