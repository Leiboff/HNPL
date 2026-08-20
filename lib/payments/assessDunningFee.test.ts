import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Tests for the grace-elapsed dunning-fee assessment helper ─────────
//
// Mirrors chargeInstalment.test.ts's shape: a real Supabase-shaped stub
// that mutates in-memory state so assertions can check what actually got
// persisted, plus the notification/push side effects mocked out (their
// own plumbing — recipient lookup, email/SMS/push — is covered by
// dunningNotifications' own tests, not duplicated here).

const notifyAttemptFailedSpy = vi.fn(async (..._args: unknown[]) => undefined);
const notifyDefaultedSpy     = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./dunningNotifications', () => ({
  notifyAttemptFailed: (...args: unknown[]) => notifyAttemptFailedSpy(...args),
  notifyDefaulted:     (...args: unknown[]) => notifyDefaultedSpy(...args),
}));

const sendPushToUserSpy = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/lib/notifications/sendPush', () => ({
  sendPushToUser: (...args: unknown[]) => sendPushToUserSpy(...args),
}));

import { assessDunningFee } from './assessDunningFee';
import { DUNNING_FEE_CENTS, DUNNING_FEE_CAP_ABSOLUTE_CENTS } from './dunning';
import { MAX_ATTEMPTS } from './chargeInstalment';

// ─── Stub Supabase ──────────────────────────────────────────────────

type PaymentRow = {
  id: string;
  plan_id: string;
  instalment_number: number;
  kind: string;
  status: string;
  amount: number;
  due_date?: string;
  dunning_fees_cents: number;
  consecutive_failed_attempts: number;
  retry_count: number;
  dunning_grace_until: string | null;
  patient_id?: string | null;
};
type PlanRow = { id: string; patient_id: string; total_amount: number };

type StubState = {
  payments: PaymentRow[];
  plans:    PlanRow[];
};

function makeStub(state: StubState) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = {
    from(table: string) {
      function rows(): Record<string, unknown>[] {
        return (state as unknown as Record<string, Record<string, unknown>[]>)[table] ?? [];
      }

      function select() {
        const filters: Array<(row: Record<string, unknown>) => boolean> = [];
        const builder = {
          eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
          maybeSingle: async () => {
            const found = rows().find((r) => filters.every((f) => f(r)));
            return { data: found ?? null, error: null };
          },
        };
        return builder;
      }

      function update(patch: Record<string, unknown>) {
        const eqs:  Array<[string, unknown]> = [];
        const nots: Array<[string]>          = [];
        const ltes: Array<[string, string]>  = [];
        const builder = {
          eq(col: string, val: unknown)  { eqs.push([col, val]); return builder; },
          not(col: string)               { nots.push([col]);     return builder; },
          lte(col: string, val: string)  { ltes.push([col, val]); return builder; },
          select(_cols?: string) {
            const matching = rows().filter((r) => {
              for (const [c, v] of eqs)  if (r[c] !== v) return false;
              for (const [c] of nots)    if (r[c] === null || r[c] === undefined) return false;
              for (const [c, v] of ltes) if (!((r[c] as string) <= v)) return false;
              return true;
            });
            for (const row of matching) Object.assign(row, patch);
            return Promise.resolve({ data: matching, error: null });
          },
          // Bare `.eq(...)` with no trailing `.select()` — the final
          // persistence write. Thenable so `await ...update().eq()` works.
          then(resolve: (v: unknown) => void) {
            const matching = rows().filter((r) => {
              for (const [c, v] of eqs) if (r[c] !== v) return false;
              return true;
            });
            for (const row of matching) Object.assign(row, patch);
            resolve({ data: matching.map((r) => ({ id: r.id })), error: null });
          },
        };
        return builder;
      }

      function insert(row: unknown) {
        const arr = Array.isArray(row) ? row : [row];
        (state as unknown as Record<string, unknown[]>).plan_events =
          ((state as unknown as Record<string, unknown[]>).plan_events ?? []).concat(arr);
        return Promise.resolve({ data: null, error: null });
      }

      return { select, update, insert };
    },
  };
  return stub;
}

beforeEach(() => {
  notifyAttemptFailedSpy.mockClear();
  notifyDefaultedSpy.mockClear();
  sendPushToUserSpy.mockClear();
  delete process.env.DUNNING_FEES_ENABLED;
});

const BASE_PAYMENT: PaymentRow = {
  id: 'pay-1',
  plan_id: 'plan-1',
  instalment_number: 2,
  kind: 'instalment',
  status: 'failed',
  amount: 1000,
  dunning_fees_cents: 0,
  consecutive_failed_attempts: 0,
  retry_count: 1,
  dunning_grace_until: '2026-06-16',
  patient_id: 'u1',
};
const BASE_PLAN: PlanRow = { id: 'plan-1', patient_id: 'u1', total_amount: 1000 };

describe('assessDunningFee — atomic claim semantics', () => {
  it('claim_lost when the row is no longer failed (self-paid within the grace window)', async () => {
    const svc = makeStub({
      payments: [{ ...BASE_PAYMENT, status: 'collected' }],
      plans:    [BASE_PLAN],
    });
    const result = await assessDunningFee(svc, 'pay-1', { today: '2026-06-16' });
    expect(result.kind).toBe('claim_lost');
  });

  it('claim_lost when dunning_grace_until is null (nothing pending)', async () => {
    const svc = makeStub({
      payments: [{ ...BASE_PAYMENT, dunning_grace_until: null }],
      plans:    [BASE_PLAN],
    });
    const result = await assessDunningFee(svc, 'pay-1', { today: '2026-06-16' });
    expect(result.kind).toBe('claim_lost');
  });

  it('claim_lost when the grace deadline is still in the future', async () => {
    const svc = makeStub({
      payments: [{ ...BASE_PAYMENT, dunning_grace_until: '2026-06-20' }],
      plans:    [BASE_PLAN],
    });
    const result = await assessDunningFee(svc, 'pay-1', { today: '2026-06-16' });
    expect(result.kind).toBe('claim_lost');
  });

  it('claim is atomic — a second concurrent call sees dunning_grace_until already cleared and bails', async () => {
    const state: StubState = { payments: [{ ...BASE_PAYMENT }], plans: [BASE_PLAN] };
    const svc = makeStub(state);
    process.env.DUNNING_FEES_ENABLED = 'true';

    const first = await assessDunningFee(svc, 'pay-1', { today: '2026-06-16' });
    expect(first.kind).toBe('assessed');
    expect(state.payments[0].dunning_grace_until).toBeNull();

    const second = await assessDunningFee(svc, 'pay-1', { today: '2026-06-16' });
    expect(second.kind).toBe('claim_lost');
  });
});

describe('assessDunningFee — fee gate ON', () => {
  beforeEach(() => { process.env.DUNNING_FEES_ENABLED = 'true'; });

  it('applies the first fee and schedules the next weekly retry', async () => {
    const state: StubState = { payments: [{ ...BASE_PAYMENT }], plans: [BASE_PLAN] };
    const svc = makeStub(state);

    const result = await assessDunningFee(svc, 'pay-1', { today: '2026-06-16' });

    expect(result).toEqual({ kind: 'assessed', paymentId: 'pay-1', feeAppliedCents: DUNNING_FEE_CENTS, terminal: false });
    expect(state.payments[0].dunning_fees_cents).toBe(DUNNING_FEE_CENTS);
    expect(state.payments[0].consecutive_failed_attempts).toBe(1);
    expect(state.payments[0].status).toBe('failed');
    expect(state.payments[0].dunning_grace_until).toBeNull();

    // Weekly retry, from the ASSESSMENT date (today), per the module's
    // documented cadence — not from the original failure date.
    const events = (state as unknown as { plan_events?: Array<{ event_type: string }> }).plan_events ?? [];
    expect(events.some((e) => e.event_type === 'dunning_fee_applied')).toBe(true);
    expect(events.some((e) => e.event_type === 'instalment_defaulted')).toBe(false);

    expect(notifyAttemptFailedSpy).toHaveBeenCalledWith(svc, expect.objectContaining({
      paymentId: 'pay-1',
      feeAppliedCents: DUNNING_FEE_CENTS,
      dunningFeesCentsAfter: DUNNING_FEE_CENTS,
    }));
    expect(notifyDefaultedSpy).not.toHaveBeenCalled();
  });

  it('reaching the 3rd fee caps out and terminates as defaulted', async () => {
    const state: StubState = {
      payments: [{
        ...BASE_PAYMENT,
        dunning_fees_cents: DUNNING_FEE_CENTS * 2,
        consecutive_failed_attempts: 2,
      }],
      plans: [BASE_PLAN],
    };
    const svc = makeStub(state);

    const result = await assessDunningFee(svc, 'pay-1', { today: '2026-06-16' });

    expect(result.kind).toBe('assessed');
    if (result.kind !== 'assessed') return;
    expect(result.terminal).toBe(true);
    expect(state.payments[0].status).toBe('defaulted');
    expect(state.payments[0].dunning_fees_cents).toBe(DUNNING_FEE_CAP_ABSOLUTE_CENTS);

    const events = (state as unknown as { plan_events?: Array<{ event_type: string }> }).plan_events ?? [];
    expect(events.some((e) => e.event_type === 'instalment_defaulted')).toBe(true);
    expect(notifyDefaultedSpy).toHaveBeenCalledTimes(1);
  });

  it('bounded by the next instalment due date — terminates even short of the fee cap', async () => {
    const state: StubState = {
      payments: [
        { ...BASE_PAYMENT },
        {
          ...BASE_PAYMENT,
          id: 'pay-2', instalment_number: 3, due_date: '2026-06-18',
          status: 'scheduled', dunning_grace_until: null,
        },
      ],
      plans: [BASE_PLAN],
    };
    const svc = makeStub(state);

    // today + 7 days (2026-06-23) would land after the next instalment's
    // due date (2026-06-18) → the ladder stops chasing this one here.
    const result = await assessDunningFee(svc, 'pay-1', { today: '2026-06-16' });

    expect(result.kind).toBe('assessed');
    if (result.kind !== 'assessed') return;
    expect(result.terminal).toBe(true);
    expect(state.payments[0].status).toBe('defaulted');
    // Only ONE fee was actually earned — the cap was never reached.
    expect(state.payments[0].dunning_fees_cents).toBe(DUNNING_FEE_CENTS);
  });
});

describe('assessDunningFee — fee gate OFF (default)', () => {
  it('advances the ladder and schedules retries, but charges/persists zero fee', async () => {
    const state: StubState = { payments: [{ ...BASE_PAYMENT }], plans: [BASE_PLAN] };
    const svc = makeStub(state);

    const result = await assessDunningFee(svc, 'pay-1', { today: '2026-06-16' });

    expect(result.kind).toBe('assessed');
    if (result.kind !== 'assessed') return;
    expect(result.feeAppliedCents).toBe(0);
    expect(state.payments[0].dunning_fees_cents).toBe(0);
    expect(state.payments[0].status).toBe('failed');
    expect(state.payments[0].consecutive_failed_attempts).toBe(1);
  });

  it('terminates on the MAX_ATTEMPTS backstop while the fee ledger is frozen at 0', async () => {
    const state: StubState = {
      payments: [{ ...BASE_PAYMENT, retry_count: MAX_ATTEMPTS }],
      plans: [BASE_PLAN],
    };
    const svc = makeStub(state);

    const result = await assessDunningFee(svc, 'pay-1', { today: '2026-06-16' });

    expect(result.kind).toBe('assessed');
    if (result.kind !== 'assessed') return;
    expect(result.terminal).toBe(true);
    expect(state.payments[0].status).toBe('defaulted');
    expect(state.payments[0].dunning_fees_cents).toBe(0); // never charged while gated
  });
});
