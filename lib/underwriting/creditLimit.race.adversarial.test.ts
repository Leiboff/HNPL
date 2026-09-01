// ─── ADVERSARIAL PROOF — audit 2026-09-02, finding A-04 ───────────────────
//
// `checkCreditLimit` is a READ followed by a DECISION, and the write that
// commits the exposure happens later, in the caller. Nothing between them is
// atomic: no row lock on the profile, no serialisable transaction, and no
// database constraint that relates `payments` in aggregate to
// `profiles.approved_credit_limit`.
//
// So two requests that overlap both see the pre-write exposure, both find
// headroom, and both proceed. The limit is not a limit; it is a limit per
// request. N concurrent requests give N times the approved exposure.
//
// This test drives the REAL `checkCreditLimit` against a stub client whose
// only job is to hold the row set, so the interleaving under test is the
// production function's own read pattern — not a re-implementation of it.
//
// The exploit needs no special access: the patient opens two bills (two
// practices, or the same practice twice) and submits both acceptances at the
// same moment. Both are legitimate requests; the ordering is the attack.
//
// WHEN THIS IS FIXED, invert the final assertion of the concurrent test —
// the second decision must come back `over_limit`. The fix has to make the
// check-and-commit one atomic step (a SECURITY DEFINER RPC that locks the
// profile row and inserts the schedule, or a deferred constraint trigger on
// `payments` that re-derives exposure), so the test will need to move to
// pglite at that point. The interleaving proved here is what any candidate
// fix must refuse.

import { describe, it, expect } from 'vitest';
import { checkCreditLimit, outstandingExposure } from './creditLimit';

const PATIENT = '00000000-0000-0000-0000-0000000000aa';

type PlanRow    = { id: string; patient_id: string; status: string };
type PaymentRow = { plan_id: string; patient_id: string; amount: number; kind: string; status: string };

/**
 * The narrowest Supabase-shaped stub that the two functions under test
 * actually exercise: `.from().select().eq()/.in()/.neq()/.maybeSingle()`.
 *
 * Deliberately NOT a general query engine. It resolves exactly the three
 * queries creditLimit.ts issues, so if that file's read pattern changes this
 * stub fails loudly rather than silently answering something else.
 */
function stubDb(state: {
  limit: number | null;
  plans: PlanRow[];
  payments: PaymentRow[];
}) {
  return {
    from(table: string) {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const rows: Record<string, unknown>[] =
        table === 'profiles' ? [{ id: PATIENT, approved_credit_limit: state.limit }]
        : table === 'plans'  ? state.plans as unknown as Record<string, unknown>[]
        : table === 'payments' ? state.payments as unknown as Record<string, unknown>[]
        : (() => { throw new Error(`stubDb: unexpected table ${table}`); })();

      const api = {
        select() { return api; },
        eq(col: string, val: unknown)   { filters.push((r) => r[col] === val); return api; },
        neq(col: string, val: unknown)  { filters.push((r) => r[col] !== val); return api; },
        in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return api; },
        get _rows() { return rows.filter((r) => filters.every((f) => f(r))); },
        async maybeSingle() { return { data: api._rows[0] ?? null, error: null }; },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: api._rows, error: null }).then(resolve);
        },
      };
      return api;
    },
  };
}

/** Commit an accepted plan's schedule the way acceptPlan / initiateCheckout do. */
function commitPlan(
  state: { plans: PlanRow[]; payments: PaymentRow[] },
  planId: string,
  total: number,
  instalments = 2,
) {
  state.plans.push({ id: planId, patient_id: PATIENT, status: 'pending_first_payment' });
  const each = total / instalments;
  for (let i = 0; i < instalments; i++) {
    state.payments.push({
      plan_id: planId, patient_id: PATIENT, amount: each,
      kind: 'instalment', status: i === 0 ? 'processing' : 'scheduled',
    });
  }
}

describe('A-04 — the credit limit is a check-then-act with no atomicity', () => {
  it('refuses the second bill when the two are SEQUENTIAL (the happy path)', async () => {
    const state = { limit: 5000, plans: [] as PlanRow[], payments: [] as PaymentRow[] };

    const first = await checkCreditLimit(stubDb(state), PATIENT, 5000);
    expect(first.ok).toBe(true);

    // The first acceptance commits its schedule before the second request
    // arrives, so the second read sees the exposure.
    commitPlan(state, 'plan-1', 5000);

    const second = await checkCreditLimit(stubDb(state), PATIENT, 5000);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('over_limit');
  });

  it('EXPLOIT: admits both bills when the two checks interleave', async () => {
    const state = { limit: 5000, plans: [] as PlanRow[], payments: [] as PaymentRow[] };

    // Both requests read before either writes. This is the ordinary
    // serverless shape: two lambdas, two connections, no lock between them.
    const [a, b] = await Promise.all([
      checkCreditLimit(stubDb(state), PATIENT, 5000),
      checkCreditLimit(stubDb(state), PATIENT, 5000),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);   // ← the defect

    // …and then both commit.
    commitPlan(state, 'plan-1', 5000);
    commitPlan(state, 'plan-2', 5000);

    const exposure = await outstandingExposure(stubDb(state), PATIENT);
    expect(exposure.ok).toBe(true);
    if (exposure.ok) {
      // R10,000 of live exposure against an approved limit of R5,000.
      expect(exposure.rands).toBe(10000);
      expect(exposure.rands).toBeGreaterThan(state.limit!);
    }
  });

  it('EXPLOIT scales linearly — five concurrent bills give five times the limit', async () => {
    const state = { limit: 5000, plans: [] as PlanRow[], payments: [] as PaymentRow[] };

    const decisions = await Promise.all(
      Array.from({ length: 5 }, () => checkCreditLimit(stubDb(state), PATIENT, 5000)),
    );
    expect(decisions.every((d) => d.ok)).toBe(true);

    decisions.forEach((_, i) => commitPlan(state, `plan-${i}`, 5000));
    const exposure = await outstandingExposure(stubDb(state), PATIENT);
    if (exposure.ok) expect(exposure.rands).toBe(25000);
  });

  it('a patient with NO approved limit is refused — so the gate only exists once onboarding grants one', async () => {
    const state = { limit: null, plans: [] as PlanRow[], payments: [] as PaymentRow[] };
    const decision = await checkCreditLimit(stubDb(state), PATIENT, 100);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('no_limit');

    // Which is why A-05 matters: initiateCheckout SKIPS this call entirely
    // when it has just created the account (`if (!isNewUser)`), so a brand
    // new patient's first bill is bounded only by MAX_BILL_AMOUNT — R50,000
    // by default, ten times the limit the stub policy grants.
  });
});
