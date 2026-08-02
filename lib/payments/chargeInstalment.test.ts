import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Tests for the atomic claim + charge helper ─────────────────────
//
// Peach edition. Same claim / retry-cap / dunning / idempotency
// semantics as the pre-swap Paystack tests — only the inner charge
// call changed from paystackRequest(/transaction/charge_authorization)
// to provider.chargeSavedCard(). The tests here mock the provider so
// we can assert the request shape and simulate transport-level errors.

const chargeSavedCardSpy = vi.fn();

vi.mock('./provider', () => ({
  getPaymentProvider: () => ({
    chargeSavedCard: (...args: unknown[]) => chargeSavedCardSpy(...args),
  }),
}));

import { attemptChargeInstalment, MAX_ATTEMPTS } from './chargeInstalment';

// ─── Stub Supabase ──────────────────────────────────────────────────

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
  id:                             string;
  peach_registration_id:          string | null;
  peach_initial_transaction_id?:  string | null;
  patient_id:                     string;
  status:                         string;
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

// Default: provider responds with a successful charge. Tests can override.
function stubSuccess() {
  chargeSavedCardSpy.mockResolvedValue({
    status:            'success',
    providerPaymentId: 'peach-payment-abc',
    resultCode:        '000.100.110',
  });
}

beforeEach(() => {
  chargeSavedCardSpy.mockReset();
});

// ─── attemptChargeInstalment ────────────────────────────────────────

describe('attemptChargeInstalment — atomic claim semantics', () => {
  it('returns claim_lost when the row is already in processing (concurrent claim)', async () => {
    const svc = makeStub({
      payments: [{
        id: 'p1', status: 'processing', retry_count: 1, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
      today:    '2026-06-15',
    });
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    expect(chargeSavedCardSpy).not.toHaveBeenCalled();
  });

  it('returns claim_lost when retry_count is already at the cap', async () => {
    const svc = makeStub({
      payments: [{
        id: 'p1', status: 'failed', retry_count: MAX_ATTEMPTS, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    });
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    expect(chargeSavedCardSpy).not.toHaveBeenCalled();
  });

  it('returns claim_lost when due_date is in the future', async () => {
    const svc = makeStub({
      payments: [{
        id: 'p1', status: 'scheduled', retry_count: 0, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-07-01',
      }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    });
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    expect(chargeSavedCardSpy).not.toHaveBeenCalled();
  });

  it('claim is atomic — a second concurrent call to the same row sees status=processing and bails', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'scheduled' as string, retry_count: 0, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    stubSuccess();
    const first = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(first.kind).toBe('charged');
    expect(state.payments[0].status).toBe('processing');

    const second = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(second.kind).toBe('claim_lost');
    // Peach was called exactly ONCE despite two attempts.
    expect(chargeSavedCardSpy).toHaveBeenCalledTimes(1);
  });
});

describe('attemptChargeInstalment — successful charge', () => {
  it('writes a fresh reference, increments retry_count, stamps last_dunning_attempt_date, marks processing, calls Peach with the correct payload', async () => {
    const state: StubState = {
      payments: [{
        id: 'aaaa1111-bbbb-2222-cccc-333344445555',
        status: 'scheduled' as string, retry_count: 0, amount: 250.75,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG_ABC', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    stubSuccess();

    const result = await attemptChargeInstalment(svc, state.payments[0].id, { today: '2026-06-15' });

    expect(result.kind).toBe('charged');
    if (result.kind !== 'charged') return;
    expect(result.attemptNumber).toBe(1);
    // Compact 16-char Peach ref (Visa/Mastercard 3DS2 mandate).
    // Purpose char 'i' = MIT instalment attempt.
    expect(result.reference).toMatch(/^bni[a-z0-9]{13}$/);
    expect(result.reference.length).toBe(16);
    expect(result.amountChargedCents).toBe(25075);

    expect(state.payments[0].status).toBe('processing');
    expect(state.payments[0].retry_count).toBe(1);
    expect(state.payments[0].peach_payment_id).toBe(result.reference);
    expect(state.payments[0].last_dunning_attempt_date).toBe('2026-06-15');

    expect(chargeSavedCardSpy).toHaveBeenCalledTimes(1);
    const [args] = chargeSavedCardSpy.mock.calls as [[{
      registrationId:        string;
      amountCents:           number;
      merchantTransactionId: string;
      currency:              string;
      standingInstruction:   { mode: string; source: string; type: string };
    }]];
    expect(args[0].registrationId).toBe('REG_ABC');
    expect(args[0].amountCents).toBe(25075);
    expect(args[0].currency).toBe('ZAR');
    expect(args[0].merchantTransactionId).toBe(result.reference);
    // No initialTransactionId on the plan → UNSCHEDULED fallback.
    // (The dedicated INSTALLMENT-branch test below covers the case
    // where the plan has an initialTransactionId populated.)
    expect(args[0].standingInstruction).toEqual({
      mode:   'REPEATED',
      source: 'MIT',
      type:   'UNSCHEDULED',
    });
  });

  it('when plan.peach_initial_transaction_id is populated, uses INSTALLMENT + initialTransactionId', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'scheduled' as string, retry_count: 0, amount: 250.75,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans: [{
        id: 'plan-1',
        peach_registration_id:         'REG_ABC',
        peach_initial_transaction_id:  'txn-INIT-1',
        patient_id: 'u1', status: 'active',
      }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    stubSuccess();
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('charged');
    const [args] = chargeSavedCardSpy.mock.calls as [[{ standingInstruction: unknown }]];
    expect(args[0].standingInstruction).toEqual({
      mode:                 'REPEATED',
      source:               'MIT',
      type:                 'INSTALLMENT',
      initialTransactionId: 'txn-INIT-1',
    });
  });

  it('CHAIN-ROOT FALLBACK — a registration-only card (no peach_initial_transaction_id) charges under UNSCHEDULED without initialTransactionId', async () => {
    // Regression pin for the card-vault chain root: a registration-only
    // card (added via the Checkout V2 zero-amount PA registration
    // recipe) produces a registrationId but NO initial CIT transaction.
    // Plans that use such a card MUST send their first MIT charge under
    // type=UNSCHEDULED without an initialTransactionId — else the
    // acquirer rejects "invalid initial reference".
    const state: StubState = {
      payments: [{
        id: 'p-orphan', status: 'scheduled', retry_count: 0, amount: 200,
        plan_id: 'plan-orphan', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans: [{
        id: 'plan-orphan',
        peach_registration_id:        'REG_FROM_COPYANDPAY_VAULT',
        peach_initial_transaction_id: null,  // vault path never populates this
        patient_id: 'u1', status: 'active',
      }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    stubSuccess();
    const result = await attemptChargeInstalment(svc, 'p-orphan', { today: '2026-06-15' });
    expect(result.kind).toBe('charged');
    const [args] = chargeSavedCardSpy.mock.calls as [[{ standingInstruction: Record<string, unknown> }]];
    expect(args[0].standingInstruction).toEqual({
      mode:   'REPEATED',
      source: 'MIT',
      type:   'UNSCHEDULED',
    });
    expect(args[0].standingInstruction.initialTransactionId).toBeUndefined();
  });

  it('on retry of a previously failed row, attemptNumber increments and reference reflects it', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'failed' as string, retry_count: 2, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    stubSuccess();
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('charged');
    if (result.kind !== 'charged') return;
    expect(result.attemptNumber).toBe(3);
    // Compact ref shape — attempt-differentiated by the deterministic
    // hash of (paymentId, attempt), not by a visible `_aN` suffix.
    expect(result.reference).toMatch(/^bni[a-z0-9]{13}$/);
    expect(state.payments[0].retry_count).toBe(3);
  });

  it('reference differs from attempt to attempt on the same payment (attempt-differentiated)', async () => {
    // Regression pin: attempt=1 and attempt=3 must produce DIFFERENT
    // refs (Peach dedups on identical merchantTransactionId — same ref
    // would collapse a retry into the first attempt's outcome).
    // Attempt=1 case
    const s1: StubState = {
      payments: [{ id: 'p1', status: 'scheduled', retry_count: 0, amount: 100, plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14' }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc1 = makeStub(s1);
    stubSuccess();
    const r1 = await attemptChargeInstalment(svc1, 'p1', { today: '2026-06-15' });
    // Attempt=3 case (same payment id)
    const s2: StubState = {
      payments: [{ id: 'p1', status: 'failed',    retry_count: 2, amount: 100, plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14' }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc2 = makeStub(s2);
    stubSuccess();
    const r3 = await attemptChargeInstalment(svc2, 'p1', { today: '2026-06-15' });
    if (r1.kind !== 'charged' || r3.kind !== 'charged') throw new Error('setup');
    expect(r1.reference).not.toBe(r3.reference);
  });

  it('includes accrued dunning fees in the Peach amount (retry-carries-fees)', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'failed', retry_count: 2, amount: 250,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
        dunning_fees_cents: 10_000, // R100 accrued
      }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    stubSuccess();
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('charged');
    if (result.kind !== 'charged') return;
    // 250.00 instalment + R100 fees = R350 = 35000 cents
    expect(result.amountChargedCents).toBe(35_000);
    const [args] = chargeSavedCardSpy.mock.calls as [[{ amountCents: number }]];
    expect(args[0].amountCents).toBe(35_000);
  });
});

describe('attemptChargeInstalment — Peach transport error', () => {
  it('does NOT revert the row when Peach returns status=error — claim stays in processing for manual reconcile', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'scheduled' as string, retry_count: 0, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    chargeSavedCardSpy.mockResolvedValue({ status: 'error', resultDescription: 'Peach 502' });

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
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'cancelled' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    if (result.kind === 'claim_lost') expect(result.reason).toBe('plan_not_active');
    expect(state.payments[0].status).toBe('scheduled');
    expect(state.payments[0].retry_count).toBe(0);
    expect(state.payments[0].peach_payment_id).toBeNull();
    expect(chargeSavedCardSpy).not.toHaveBeenCalled();
  });

  it('reverts the claim when the plan has no stored registration id', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'scheduled' as string, retry_count: 0, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
      }],
      plans:    [{ id: 'plan-1', peach_registration_id: null, patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    if (result.kind === 'claim_lost') expect(result.reason).toBe('no_registration_id');
    expect(state.payments[0].status).toBe('scheduled');
    expect(state.payments[0].retry_count).toBe(0);
    expect(chargeSavedCardSpy).not.toHaveBeenCalled();
  });
});

// ─── self-settle path ──────────────────────────────────────────────

describe('attemptChargeInstalment — selfSettle widens the claim', () => {
  it('charges a defaulted row when selfSettle=true', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'defaulted', retry_count: 6, amount: 250,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
        dunning_fees_cents: 30_000,
      }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    stubSuccess();
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
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    const result = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    expect(result.kind).toBe('claim_lost');
    expect(chargeSavedCardSpy).not.toHaveBeenCalled();
  });

  it('selfSettle race vs cron — exactly one charge fires', async () => {
    const state: StubState = {
      payments: [{
        id: 'p1', status: 'failed', retry_count: 2, amount: 100,
        plan_id: 'plan-1', patient_id: 'u1', due_date: '2026-06-14',
        dunning_fees_cents: 10_000,
      }],
      plans:    [{ id: 'plan-1', peach_registration_id: 'REG', patient_id: 'u1', status: 'active' }],
      profiles: [{ id: 'u1', email: 'u@example.com' }],
    };
    const svc = makeStub(state);
    stubSuccess();

    const cron       = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15' });
    const selfSettle = await attemptChargeInstalment(svc, 'p1', { today: '2026-06-15', selfSettle: true });

    // Whichever ran first claimed; the other got claim_lost.
    const outcomes = [cron.kind, selfSettle.kind].sort();
    expect(outcomes).toEqual(['charged', 'claim_lost']);
    expect(chargeSavedCardSpy).toHaveBeenCalledTimes(1);
  });
});
