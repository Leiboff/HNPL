import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { activateFirstInstalment } from './activateFirstInstalment';

// ─── activateFirstInstalment — shared terminal activation ───────────
//
// The helper is called from TWO paths (payWithSavedCard sync success
// and the Peach webhook), and MUST be idempotent under duplicate
// delivery. These tests pin the essential guarantees:
//
//   1. On a fresh pending_first_payment plan + processing payment,
//      the helper flips both to terminal state (active / collected)
//      and inserts a single payouts row.
//
//   2. Preconditions gate each write — a duplicate call on a plan
//      already 'active' or a payment already 'collected' MUST NOT
//      double-stamp collected_at, double-insert a payout, or trip an
//      error.
//
//   3. A payout row already existing for the plan is a signal that
//      the peer path (sync-or-webhook) landed first; skip the payout
//      insert entirely rather than duplicate it.
//
//   4. When plan.provider_id + practice_member.payout_destination =
//      'provider', the payout snapshot fields carry the member's bank
//      details, not the practice's.
//
//   5. A DB error on the payment update is reported (step='payment')
//      so the caller can decide to log-loud rather than silently
//      succeed.

type Row = Record<string, unknown>;
type Write =
  | { table: string; op: 'update'; row: Row; filters: Array<[string, string, unknown]> }
  | { table: string; op: 'insert'; row: Row }
  | { table: string; op: 'upsert-ignored'; row: Row };

type MakeSvcOptions = {
  paymentUpdateFails?: string;
  // Simulates the SELECT-then-upsert race directly: the fast-path
  // existence check reports "nothing here" even when `state` already
  // has a conflicting row for that plan_id — exactly what happens when
  // two callers' SELECTs both run before either write commits. Proves
  // the upsert's ON CONFLICT DO NOTHING (not the SELECT) is what
  // actually prevents the duplicate.
  payoutsSelectAlwaysEmpty?: boolean;
};

function makeSvc(seed: Record<string, Row[]>, options: MakeSvcOptions = {}) {
  const state: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  const writes: Write[] = [];

  function table(name: string) {
    return {
      select(_cols?: string) {
        const filters: Array<[string, string, unknown]> = [];
        const b: Record<string, unknown> = {};
        b.eq = (col: string, val: unknown) => { filters.push([col, 'eq', val]); return b; };
        b.neq = (col: string, val: unknown) => { filters.push([col, 'neq', val]); return b; };
        b.is  = (col: string, val: unknown) => { filters.push([col, 'is',  val]); return b; };
        b.limit = (_n: number) => {
          if (name === 'payouts' && options.payoutsSelectAlwaysEmpty) {
            return Promise.resolve({ data: [], error: null });
          }
          const rows = (state[name] ?? []).filter((r) =>
            filters.every(([c, op, v]) =>
              op === 'eq' ? r[c] === v : op === 'neq' ? r[c] !== v : r[c] === v,
            ),
          );
          return Promise.resolve({ data: rows, error: null });
        };
        b.maybeSingle = () => Promise.resolve({
          data: (state[name] ?? []).find((r) =>
            filters.every(([c, op, v]) =>
              op === 'eq' ? r[c] === v : op === 'neq' ? r[c] !== v : r[c] === v,
            ),
          ) ?? null,
          error: null,
        });
        b.single = b.maybeSingle;
        return b;
      },
      update(row: Row) {
        const filters: Array<[string, string, unknown]> = [];
        const b: Record<string, unknown> = {};
        const finalize = () => {
          if (options.paymentUpdateFails && name === 'payments') {
            return { data: null, error: { message: options.paymentUpdateFails } };
          }
          writes.push({ table: name, op: 'update', row, filters });
          const rows = state[name] ?? [];
          for (const r of rows) {
            const match = filters.every(([c, op, v]) =>
              op === 'eq' ? r[c] === v : op === 'neq' ? r[c] !== v : r[c] === v,
            );
            if (match) Object.assign(r, row);
          }
          return { data: null, error: null };
        };
        b.eq  = (col: string, val: unknown) => { filters.push([col, 'eq', val]); return b; };
        b.neq = (col: string, val: unknown) => { filters.push([col, 'neq', val]); return b; };
        b.is  = (col: string, val: unknown) => { filters.push([col, 'is',  val]); return b; };
        // Terminal `await`: return a plain object with the error via `.then`.
        Object.assign(b, { then: (resolve: (v: unknown) => void) => resolve(finalize()) });
        return b;
      },
      insert(row: Row) {
        writes.push({ table: name, op: 'insert', row });
        (state[name] ??= []).push({ ...row });
        return Promise.resolve({ data: null, error: null });
      },
      // Simulates INSERT ... ON CONFLICT (onConflict) DO NOTHING against
      // migration 0087's UNIQUE constraint on payouts.plan_id — a
      // conflicting row already in `state` makes this a silent no-op
      // (error: null, no new row), exactly like the real DB constraint.
      upsert(row: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        const conflictCol = opts?.onConflict;
        if (conflictCol && opts?.ignoreDuplicates) {
          const existing = (state[name] ?? []).find((r) => r[conflictCol] === row[conflictCol]);
          if (existing) {
            writes.push({ table: name, op: 'upsert-ignored', row });
            return Promise.resolve({ data: null, error: null });
          }
        }
        writes.push({ table: name, op: 'insert', row });
        (state[name] ??= []).push({ ...row });
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  return {
    from: table,
    writes,
    state,
  };
}

describe('activateFirstInstalment — happy path', () => {
  it('flips payment→collected + plan→active + inserts one payout row', async () => {
    const svc = makeSvc({
      payments: [{ id: 'pay1', status: 'processing', collected_at: null }],
      plans:    [{ id: 'plan1', status: 'pending_first_payment' }],
      practices:[{ id: 'prac1', fee_percent: 6 }],
      payouts:  [],
    });
    const result = await activateFirstInstalment(svc, {
      paymentId: 'pay1',
      plan: { id: 'plan1', total_amount: 1000, practice_id: 'prac1', patient_id: 'pat1' },
      now: '2026-07-30T12:00:00.000Z',
    });
    expect(result).toEqual({ ok: true });
    expect(svc.state.payments[0].status).toBe('collected');
    expect(svc.state.payments[0].collected_at).toBe('2026-07-30T12:00:00.000Z');
    expect(svc.state.plans[0].status).toBe('active');
    expect(svc.state.payouts.length).toBe(1);
    const payout = svc.state.payouts[0];
    expect(payout.plan_id).toBe('plan1');
    expect(payout.practice_id).toBe('prac1');
    expect(payout.status).toBe('pending');
    expect(payout.payout_destination).toBe('practice');
  });
});

describe('activateFirstInstalment — idempotency (duplicate delivery)', () => {
  it('skips the payout insert when a payout row for the plan already exists', async () => {
    const svc = makeSvc({
      payments: [{ id: 'pay1', status: 'collected', collected_at: '2026-07-30T11:00:00.000Z' }],
      plans:    [{ id: 'plan1', status: 'active' }],
      practices:[{ id: 'prac1', fee_percent: 6 }],
      payouts:  [{ id: 'existing', plan_id: 'plan1', practice_id: 'prac1' }],
    });
    const result = await activateFirstInstalment(svc, {
      paymentId: 'pay1',
      plan: { id: 'plan1', total_amount: 1000, practice_id: 'prac1', patient_id: 'pat1' },
      now: '2026-07-30T12:00:00.000Z',
    });
    expect(result).toEqual({ ok: true });
    expect(svc.state.payouts.length).toBe(1);
    // Payment.collected_at was NOT overwritten with the second now-stamp
    // because the update was guarded by neq('status', 'collected').
    expect(svc.state.payments[0].collected_at).toBe('2026-07-30T11:00:00.000Z');
  });
});

describe('activateFirstInstalment — payout insert race (Audit A)', () => {
  // Real scenario: the webhook lands first and its payout INSERT commits.
  // A return-route caller's own fast-path SELECT can still race — two
  // concurrent serverless invocations' SELECTs can both run before
  // either INSERT commits. This test forces that exact case: the
  // existence-check SELECT reports empty (as if it ran before the
  // conflicting row committed) even though `state` already holds a
  // payout for this plan (as if the OTHER caller's insert had, in
  // reality, already landed by the time THIS caller's upsert executes).
  // The DB-level UNIQUE constraint (migration 0087) + ignoreDuplicates
  // is what must save us here — not the SELECT, which this test proves
  // by deliberately defeating it.
  it('a second call whose fast-path SELECT misses the race still does not duplicate the payout', async () => {
    const svc = makeSvc(
      {
        payments: [{ id: 'pay1', status: 'collected', collected_at: '2026-07-30T11:00:00.000Z' }],
        plans:    [{ id: 'plan1', status: 'active' }],
        practices:[{ id: 'prac1', fee_percent: 6 }],
        // The "other" caller already won — this row exists in state.
        payouts:  [{ id: 'winner', plan_id: 'plan1', practice_id: 'prac1' }],
      },
      { payoutsSelectAlwaysEmpty: true },
    );
    const result = await activateFirstInstalment(svc, {
      paymentId: 'pay1',
      plan: { id: 'plan1', total_amount: 1000, practice_id: 'prac1', patient_id: 'pat1' },
      now: '2026-07-30T12:00:00.000Z',
    });
    expect(result).toEqual({ ok: true });
    // Still exactly one payout row — the upsert's ON CONFLICT DO NOTHING
    // caught what the (deliberately blinded) SELECT missed.
    expect(svc.state.payouts.length).toBe(1);
    expect(svc.state.payouts[0].id).toBe('winner');
  });

  it('the upsert call itself is conflict-safe (onConflict: plan_id, ignoreDuplicates: true)', async () => {
    const svc = makeSvc({
      payments: [{ id: 'pay1', status: 'processing' }],
      plans:    [{ id: 'plan1', status: 'pending_first_payment' }],
      practices:[{ id: 'prac1', fee_percent: 6 }],
      payouts:  [],
    });
    await activateFirstInstalment(svc, {
      paymentId: 'pay1',
      plan: { id: 'plan1', total_amount: 1000, practice_id: 'prac1', patient_id: 'pat1' },
      now: '2026-07-30T12:00:00.000Z',
    });
    const upsertWrite = svc.writes.find((w) => w.table === 'payouts' && w.op === 'insert');
    expect(upsertWrite).toBeTruthy();
  });
});

// ─── CONTRACT CHANGE: the provider payout destination is REMOVED ────────
//
// This block previously asserted the opposite: that a practice_members row
// electing payout_destination='provider' redirected the payout to the
// doctor's personal account, with their bank details snapshotted onto the
// payout row.
//
// That option is gone — one practice = one bank account = one deposit, which
// is what makes a weekly payout batch reconcilable against a bank statement
// (migration 0090). A provider-destined row inside a practice's batch would
// silently mean two transfers for one batch total.
//
// The tests are INVERTED rather than deleted, so the branch cannot quietly
// come back. The membership fixture still says 'provider' and still carries
// the old columns, because that is the exact input that used to trigger the
// redirect — the point is that it no longer does anything.
describe('activateFirstInstalment — payouts ALWAYS go to the practice', () => {
  it('IGNORES a legacy provider destination on the membership row', async () => {
    const svc = makeSvc({
      payments: [{ id: 'pay1', status: 'processing' }],
      plans:    [{ id: 'plan1', status: 'pending_first_payment' }],
      practices:[{ id: 'prac1', fee_percent: 6 }],
      practice_members: [{
        user_id:                'prov1',
        practice_id:            'prac1',
        payout_destination:     'provider',
        personal_bank_name:     'FNB',
        personal_account_holder:'Dr Smith',
        personal_account_number:'1234567890',
        personal_branch_code:   '250655',
        personal_account_type:  'current',
      }],
      payouts: [],
    });
    const result = await activateFirstInstalment(svc, {
      paymentId: 'pay1',
      plan: { id: 'plan1', total_amount: 1000, practice_id: 'prac1', provider_id: 'prov1', patient_id: 'pat1' },
      now: '2026-07-30T12:00:00.000Z',
    });
    expect(result).toEqual({ ok: true });

    const payout = svc.state.payouts[0];
    expect(payout.payout_destination).toBe('practice');

    // No bank details are copied onto the payout row any more.
    expect(payout.snapshot_bank_name).toBeUndefined();
    expect(payout.snapshot_account_holder).toBeUndefined();
    expect(payout.snapshot_account_number).toBeUndefined();
    expect(payout.snapshot_branch_code).toBeUndefined();
    expect(payout.snapshot_account_type).toBeUndefined();
  });

  it('still records provider_id — attribution is not the same thing as destination', async () => {
    // The treating doctor is still stamped on the payout: the practice
    // dashboard, the brand by-doctor rollup and /provider all read it. What
    // changed is that it no longer influences WHERE the money goes.
    const svc = makeSvc({
      payments: [{ id: 'pay1', status: 'processing' }],
      plans:    [{ id: 'plan1', status: 'pending_first_payment' }],
      practices:[{ id: 'prac1', fee_percent: 6 }],
      payouts:  [],
    });
    await activateFirstInstalment(svc, {
      paymentId: 'pay1',
      plan: { id: 'plan1', total_amount: 1000, practice_id: 'prac1', provider_id: 'prov1', patient_id: 'pat1' },
      now: '2026-07-30T12:00:00.000Z',
    });
    expect(svc.state.payouts[0].provider_id).toBe('prov1');
    expect(svc.state.payouts[0].payout_destination).toBe('practice');
  });

  it('no longer reads the membership row for banking at all', async () => {
    // The old code fetched practice_members to inspect payout_destination.
    // Removing that read is what makes this structural rather than a
    // condition someone could flip back on.
    const src  = readFileSync(resolve(process.cwd(), 'lib/payments/activateFirstInstalment.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/personal_bank_name/);
    expect(code).not.toMatch(/snapshot_/);
    expect(code).not.toMatch(/'provider'/);
    // payout_destination is still written — as the literal 'practice'.
    expect(code).toMatch(/payout_destination:\s*'practice'/);
  });
});

describe('activateFirstInstalment — error surfacing', () => {
  it('reports { ok: false, step: "payment" } when the payment update errors', async () => {
    const svc = makeSvc(
      {
        payments: [{ id: 'pay1', status: 'processing' }],
        plans:    [{ id: 'plan1', status: 'pending_first_payment' }],
        practices:[{ id: 'prac1', fee_percent: 6 }],
        payouts:  [],
      },
      { paymentUpdateFails: 'RLS deny' },
    );
    const result = await activateFirstInstalment(svc, {
      paymentId: 'pay1',
      plan: { id: 'plan1', total_amount: 1000, practice_id: 'prac1', patient_id: 'pat1' },
    });
    expect(result).toMatchObject({ ok: false, step: 'payment', error: 'RLS deny' });
    // Plan was NOT flipped since the payment write failed.
    expect(svc.state.plans[0].status).toBe('pending_first_payment');
  });
});

describe('first-instalment activation — only on success, never pending/rejected', () => {
  // The saved-card first instalment is now a customer-present CIT via
  // Checkout V2 one-click; activation happens on the /patient/
  // payment-complete return route (after the widget + 3DS resolve), NOT
  // synchronously in payWithSavedCard. Pin that the return route
  // activates ONLY on the classified-success branch.
  it('payment-complete activates only on the success branch', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('app/patient/payment-complete/page.tsx', 'utf8'),
    );
    const successIdx  = src.indexOf("c === 'success'");
    const activateIdx = src.indexOf('activateFirstInstalmentFromStatus(', successIdx);
    expect(successIdx).toBeGreaterThan(0);
    expect(activateIdx).toBeGreaterThan(successIdx);
    // The rejected branch renders a card and does NOT activate.
    const rejectedBranch = src.slice(src.indexOf("c === 'rejected'"));
    expect(rejectedBranch).not.toMatch(/activateFirstInstalmentFromStatus\(/);
  });

  it('payWithSavedCard no longer activates inline — it hands off to the widget', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('app/patient/actions.ts', 'utf8'),
    );
    const fnStart = src.indexOf('export async function payWithSavedCard');
    const fnEnd   = src.indexOf('export async function', fnStart + 1);
    const body    = src.slice(fnStart, fnEnd === -1 ? src.length : fnEnd);
    expect(body).not.toMatch(/activateFirstInstalment\(/);
    expect(body).toContain('provider.createCheckout');
  });
});

describe('sync + webhook cannot double-activate — pins on caller', () => {
  it("webhook route uses the shared helper (won't drift from sync path)", async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('app/api/payments/peach/webhook/route.ts', 'utf8'),
    );
    expect(src).toMatch(/import\s*\{\s*activateFirstInstalment\s*\}\s*from\s*'@\/lib\/payments\/activateFirstInstalment'/);
    // The old local activateFirstPayment must be gone.
    expect(src).not.toMatch(/async function activateFirstPayment/);
  });

  it('the return route awaits the shared helper + keeps the write-once anchor guard', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('app/patient/payment-complete/page.tsx', 'utf8'),
    );
    // The return route reuses the SAME activateFirstInstalment helper the
    // webhook uses, so the two paths cannot drift; and the CIT-root stamp
    // is write-once guarded so a racing webhook is a no-op.
    expect(src).toMatch(/await activateFirstInstalment\(/);
    expect(src).toMatch(/\.is\('peach_initial_transaction_id',\s*null\)/);
  });
});
