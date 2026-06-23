import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Tests for the atomic claim + charge helper ─────────────────────────────
//
// The helper is the load-bearing piece for not double-charging. These
// tests use a stub Supabase client where:
//   • from('payments').select(...).eq('id', X).maybeSingle()  → snapshot
//   • from('payments').update(...).eq(...).in(...).lt(...).lte(...).select()
//        → atomic claim. The stub honours the WHERE predicates against
//          the current row so the "already claimed" case returns 0 rows.
//   • from('plans').select(...).eq('id', X).maybeSingle()  → plan
//   • from('profiles').select(...).eq('id', X).single()    → email

const paystackRequestSpy = vi.fn();

vi.mock('@/lib/paystack', () => ({
  paystackRequest: (...args: unknown[]) => paystackRequestSpy(...args),
}));

import { attemptChargeInstalment, MAX_ATTEMPTS } from './chargeInstalment';

// ─── Stub Supabase ──────────────────────────────────────────────────────────

type PaymentRow = {
  id:           string;
  status:       string;
  retry_count:  number;
  amount:       number;
  plan_id:      string;
  patient_id:   string;
  due_date:     string;
  peach_payment_id?:           string | null;
  dunning_fees_cents?:         number;
  last_dunning_attempt_date?:  string | null;
};
type PlanRow = {
  id:                          string;
  paystack_authorization_code: string | null;
  patient_id:                  string;
  status:                      string;
};
type ProfileRow = { id: string; email: string };

type StubState = {
  payments:  PaymentRow[];
  plans:     PlanRow[];
  profiles:  ProfileRow[];
  today?:    string;
};

function makeStub(state: StubState) {
  const today = state.today ?? '2026-06-15';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = {
    from(table: string) {
      function select() {
        const filters: Array<(row: Record<string, unknown>) => boolean> = [];
        const builder = {
          eq(col: string, val: unknown) {
            filters.push((r) => r[col] === val);
            return builder;
          },
          maybeSingle: async () => {
            const rows = (state as unknown as Record<string, Record<string, unknown>[]>)[table] ?? [];
            const found = rows.find((r) => filters.every((f) => f(r)));
            return { data: found ?? null, error: null };
          },
          single: async () => {
            const rows = (state as unknown as Record<string, Record<string, unknown>[]>)[table] ?? [];
            const found = rows.find((r) => filters.every((f) => f(r)));
            return { data: found ?? null, error: null };
          },
        };
        return builder;
      }

      function update(patch: Record<string, unknown>) {
        const eqs: Array<[string, unknown]> = [];
        const ins: Array<[string, unknown[]]>   = [];
        const lts: Array<[string, number]>      = [];
        const ltes: Array<[string, string]>     = [];
        const builder = {
          eq(col: string, val: unknown) { eqs.push([col, val]); return builder; },
          in(col: string, vals: unknown[]) { ins.push([col, vals]); return builder; },
          lt(col: string, val: number) { lts.push([col, val]); return builder; },
          lte(col: string, val: string) { ltes.push([col, val]); return builder; },
          gte(col: string, val: number) {
            ltes.push([col, '__GTE__:' + val]);
            return builder;
          },
          async select(_cols?: string) {
            const rows = (state as unknown as Record<string, Record<string, unknown>[]>)[table] ?? [];
            const matching = rows.filter((r) => {
              for (const [c, v] of eqs)  if (r[c] !== v) return false;
              for (const [c, vs] of ins) if (!vs.includes(r[c])) return false;
              for (const [c, v] of lts)  if (!((r[c] as number) < v)) return false;
              for (const [c, v] of ltes) {
                if (typeof v === 'string' && v.startsWith('__GTE__:')) {
                  const n = Number(v.slice(8));
                  if (!((r[c] as number) >= n)) return false;
                } else {
                  if (!((r[c] as string) <= v)) return false;
                }
              }
              return true;
            });
            for (const row of matching) Object.assign(row, patch);
            return { data: matching.map((r) => ({ id: r.id })), error: null };
          },
        };
        return builder;
      }

      return { select, update };
    },
    _state: state,
    _today: today,
  };
  return stub;
}

beforeEach(() => {
  paystackRequestSpy.mockReset();
});

// ─── attemptChargeInstalment ────────────────────────────────────────────────

describe('attemptChargeInstalment — atomic claim semantics', () => {
  it('returns claim_lost when the row is already in processing (concurrent claim)', async () => {
    const svc = makeStub({
      payments: [{
        id: 'p1', status: 'processing', retry_count: 1, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
      today:    '2026-06-15',
    });
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    expect(paystackRequestSpy).not.toHaveBeenCalled();
  });

  it('returns claim_lost when retry_count is already at the cap', async () => {
    const svc = makeStub({
      payments: [{
        id: 'p1', status: 'failed', retry_count: MAX_ATTEMPTS, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    });
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    expect(paystackRequestSpy).not.toHaveBeenCalled();
  });

  it('returns claim_lost when due_date is in the future', async () => {
    const svc = makeStub({
      payments: [{
        id: 'p1', status: 'scheduled', retry_count: 0, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-07-01',
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    });
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    expect(paystackRequestSpy).not.toHaveBeenCalled();
  });

  it('claim is atomic — a second concurrent call to the same row sees status=processing and bails', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'scheduled' as string, retry_count: 0, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    paystackRequestSpy.mockResolvedValue({ status: true });
    const first = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(first.kind).toBe('charged');
    expect(state.payments[0].status).toBe('processing');

    const second = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(second.kind).toBe('claim_lost');
    // Paystack was called exactly ONCE despite two attempts.
    expect(paystackRequestSpy).toHaveBeenCalledTimes(1);
  });
});

describe('attemptChargeInstalment — successful charge', () => {
  it('writes a fresh reference, increments retry_count, stamps last_dunning_attempt_date, marks processing, calls Paystack with the correct payload', async () => {
    const state: StubState = {
      payments: [{
        id: 'aaaa1111-bbbb-2222-cccc-333344445555',
        status: 'scheduled' as string, retry_count: 0, amount: 250.75,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH_ABC', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    paystackRequestSpy.mockResolvedValue({ status: true });

    const result = await attemptChargeInstalment(svc, state.payments[0].id, { today: '2026-06-15' });

    expect(result.kind).toBe('charged');
    if (result.kind !== 'charged') return;
    expect(result.attemptNumber).toBe(1);
    expect(result.reference).toMatch(/^hnpl_[a-f0-9]{16}_a1$/);
    expect(result.amountChargedCents).toBe(25075);

    expect(state.payments[0].status).toBe('processing');
    expect(state.payments[0].retry_count).toBe(1);
    expect(state.payments[0].peach_payment_id).toBe(result.reference);
    expect(state.payments[0].last_dunning_attempt_date).toBe('2026-06-15');

    expect(paystackRequestSpy).toHaveBeenCalledTimes(1);
    const [endpoint, opts] = paystackRequestSpy.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('/transaction/charge_authorization');
    const body = JSON.parse(opts.body as string);
    expect(body.authorization_code).toBe('AUTH_ABC');
    expect(body.email).toBe('u@example.com');
    expect(body.amount).toBe(25075);
    expect(body.currency).toBe('ZAR');
    expect(body.reference).toBe(result.reference);
  });

  it('on retry of a previously failed row, attemptNumber increments and reference reflects it', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'failed' as string, retry_count: 2, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    paystackRequestSpy.mockResolvedValue({ status: true });
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('charged');
    if (result.kind !== 'charged') return;
    expect(result.attemptNumber).toBe(3);
    expect(result.reference).toMatch(/_a3$/);
    expect(state.payments[0].retry_count).toBe(3);
  });

  it('includes accrued dunning fees in the Paystack amount (retry-carries-fees)', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'failed', retry_count: 2, amount: 250,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
        dunning_fees_cents: 10_000, // R100 accrued
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    paystackRequestSpy.mockResolvedValue({ status: true });
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('charged');
    if (result.kind !== 'charged') return;
    // 250.00 instalment + R100 fees = R350 = 35000 cents
    expect(result.amountChargedCents).toBe(35_000);
    const body = JSON.parse((paystackRequestSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.amount).toBe(35_000);
  });
});

describe('attemptChargeInstalment — Paystack transport error', () => {
  it('does NOT revert the row when Paystack throws — claim stays in processing for manual reconcile', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'scheduled' as string, retry_count: 0, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    paystackRequestSpy.mockRejectedValue(new Error('Paystack 502'));

    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('transport_error');
    expect(state.payments[0].status).toBe('processing');
    expect(state.payments[0].retry_count).toBe(1);
    expect(state.payments[0].peach_payment_id).toBeTruthy();
  });
});

describe('attemptChargeInstalment — revert on post-claim ineligibility', () => {
  it('reverts the claim when the plan turns out not to be active', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'scheduled' as string, retry_count: 0, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH', patient_id: 'u1', status: 'cancelled' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    if (result.kind === 'claim_lost') expect(result.reason).toBe('plan_not_active');
    expect(state.payments[0].status).toBe('scheduled');
    expect(state.payments[0].retry_count).toBe(0);
    expect(state.payments[0].peach_payment_id).toBeNull();
    expect(paystackRequestSpy).not.toHaveBeenCalled();
  });

  it('reverts the claim when the plan has no stored authorization code', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'scheduled' as string, retry_count: 0, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: null, patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    if (result.kind === 'claim_lost') expect(result.reason).toBe('no_authorization_code');
    expect(state.payments[0].status).toBe('scheduled');
    expect(state.payments[0].retry_count).toBe(0);
    expect(paystackRequestSpy).not.toHaveBeenCalled();
  });
});

// ─── self-settle path ──────────────────────────────────────────────────────

describe('attemptChargeInstalment — selfSettle widens the claim', () => {
  it('charges a defaulted row when selfSettle=true', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'defaulted', retry_count: 6, amount: 250,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
        dunning_fees_cents: 30_000,
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    paystackRequestSpy.mockResolvedValue({ status: true });
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15', selfSettle: true });
    expect(result.kind).toBe('charged');
    if (result.kind !== 'charged') return;
    expect(result.amountChargedCents).toBe(25_000 + 30_000); // R250 + R300 fees
    expect(state.payments[0].status).toBe('processing');
  });

  it('refuses to charge a defaulted row when selfSettle=false (cron path)', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'defaulted', retry_count: 6, amount: 250,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
        dunning_fees_cents: 30_000,
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    expect(paystackRequestSpy).not.toHaveBeenCalled();
  });

  it('selfSettle race vs cron — exactly one charge fires', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'failed', retry_count: 2, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
        dunning_fees_cents: 10_000,
      }],
      plans:    [{ id: 'plan-1', paystack_authorization_code: 'AUTH', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    paystackRequestSpy.mockResolvedValue({ status: true });

    const cron       = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    const selfSettle = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15', selfSettle: true });

    // Whichever ran first claimed; the other got claim_lost.
    const outcomes = [cron.kind, selfSettle.kind].sort();
    expect(outcomes).toEqual(['charged', 'claim_lost']);
    expect(paystackRequestSpy).toHaveBeenCalledTimes(1);
  });
});
