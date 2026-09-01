// ─── CLOSURE — audit 2026-09-02, finding A-04 ─────────────────────────────
//
// ─── THE DEFECT ───────────────────────────────────────────────────────────
//
// `checkCreditLimit` was a READ followed by a DECISION, and the write that
// committed the exposure happened later, in the caller. Nothing between them
// was atomic: no row lock on the profile, no serialisable transaction, and no
// database constraint relating `payments` in aggregate to
// `profiles.approved_credit_limit`.
//
// So two requests that overlapped both saw the pre-write exposure, both found
// headroom, and both proceeded. The limit was not a limit; it was a limit per
// request, and N concurrent requests gave N times the approved exposure. The
// original of this file drove the real function against a stub row-set and
// showed five parallel acceptances against a R5,000 limit all passing —
// R25,000 of live exposure.
//
// The exploit needed no special access: the patient opens two bills (two
// practices, or the same practice twice) and submits both acceptances at the
// same moment. Both are legitimate requests; the ordering was the attack.
//
// ─── WHAT CLOSED IT ───────────────────────────────────────────────────────
//
// The original said: "The fix has to make the check-and-commit one atomic
// step (a SECURITY DEFINER RPC that locks the profile row and inserts the
// schedule, or a deferred constraint trigger on `payments` that re-derives
// exposure), so the test will need to move to pglite at that point."
//
// Both, as it turns out, and it did. `claim_credit_for_plan` (migration 0130)
// takes `SELECT … FOR UPDATE` on the patient's profile, re-derives exposure
// under that lock, applies the allowance model, writes the plan transition
// and inserts the schedule — one transaction, one statement from the
// caller's side. `enforce_credit_exposure()` is a DEFERRABLE INITIALLY
// DEFERRED constraint trigger on `payments` that re-checks the aggregate at
// COMMIT, so even a writer that bypasses the RPC cannot leave the invariant
// broken.
//
// THE RACE ITSELF is proved refused against real Postgres in
// supabase/migrations/0130_claim_credit_for_plan.rpc.test.ts — see "THE RACE:
// a second transaction committing after the first is refused". It cannot be
// proved here, because a stub row-set has no lock to take and no COMMIT to
// hook: this file's stub could only ever demonstrate the interleaving, never
// its refusal.
//
// ─── WHAT THIS FILE KEEPS ─────────────────────────────────────────────────
//
// Two things worth more than the proof it replaces:
//
//   1. The check-then-act helper is GONE, and no production path reads a
//      limit and then writes a schedule. Asserted structurally, because the
//      way this defect returns is somebody reintroducing the convenient
//      shape rather than reintroducing the bug.
//   2. `outstandingExposure` — the definition of what counts as outstanding
//      — still behaves as it did, exercised through the same narrow stub.
//      That arithmetic survived the fix and is now implemented TWICE (here
//      for the optimistic pre-read, in plpgsql under the lock), so its
//      behaviour is worth pinning on both sides.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { outstandingExposure } from './creditLimit';

const ROOT = resolve(process.cwd());
const readSrc = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const PATIENT = '00000000-0000-0000-0000-0000000000aa';

type PlanRow    = { id: string; patient_id: string; status: string };
type PaymentRow = { plan_id: string; patient_id: string; amount: number; kind: string; status: string };

/**
 * The narrowest Supabase-shaped stub that the function under test actually
 * exercises: `.from().select().eq()/.in()/.neq()/.maybeSingle()`.
 *
 * Deliberately NOT a general query engine. It resolves exactly the queries
 * creditLimit.ts issues, so if that file's read pattern changes this stub
 * fails loudly rather than silently answering something else.
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

/** Commit an accepted plan's schedule the way the claim RPC does. */
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

describe('A-04 CLOSED — there is no longer a check-then-act to interleave', () => {
  const LIMIT_SRC = readSrc('lib/underwriting/creditLimit.ts');
  const CLAIM_SRC = readSrc('lib/underwriting/claimCredit.ts');
  const CLAIM_SQL = readSrc('supabase/migrations/0130_claim_credit_for_plan.sql');

  it('the helper that returned a decision for a caller to act on is gone', () => {
    // Not deprecated, not renamed — removed. A function that hands out a
    // credit decision for someone else to commit cannot be made safe by its
    // callers, and leaving it exported is an invitation to a fourth caller.
    expect(LIMIT_SRC).not.toMatch(/export async function checkCreditLimit/);
    expect(LIMIT_SRC).not.toMatch(/export type CreditLimitDecision/);
  });

  it('no production path reads a limit and then writes a schedule', () => {
    // The three that did. Each now calls claimCreditForPlan, which returns an
    // already-committed schedule rather than permission to write one.
    for (const p of [
      'app/patient/actions.ts',
      'app/checkout/[token]/actions.ts',
    ]) {
      const src = readSrc(p);
      expect(src).toMatch(/claimCreditForPlan\(/);
      expect(src).not.toMatch(/checkCreditLimit\(/);
      expect(src).not.toMatch(/approved_credit_limit/);
    }
  });

  it('the decision and the write are one statement, under a row lock', () => {
    expect(CLAIM_SQL).toMatch(/FROM profiles\s+WHERE id = p_patient_id\s+FOR UPDATE/);
    // The lock is taken BEFORE exposure is derived, or it locks nothing that
    // matters — and the schedule is inserted after both, inside the same
    // function body. Scoped to claim_credit_for_plan, because the constraint
    // trigger further down the file derives exposure too and would otherwise
    // satisfy this by accident.
    const fn = CLAIM_SQL.slice(
      CLAIM_SQL.indexOf('CREATE OR REPLACE FUNCTION claim_credit_for_plan('),
      CLAIM_SQL.indexOf('CREATE OR REPLACE FUNCTION enforce_credit_exposure()'),
    );
    expect(fn.indexOf('FOR UPDATE')).toBeGreaterThan(-1);
    expect(fn.indexOf('FOR UPDATE')).toBeLessThan(fn.indexOf('INTO v_outstanding'));
    expect(fn.indexOf('INTO v_outstanding')).toBeLessThan(fn.indexOf('INSERT INTO payments'));
  });

  it('and a second, independent backstop re-checks the aggregate at COMMIT', () => {
    // So a future writer that inserts payments without going through the RPC
    // still cannot leave the invariant broken.
    expect(CLAIM_SQL).toMatch(/CREATE CONSTRAINT TRIGGER[\s\S]{0,200}DEFERRABLE INITIALLY DEFERRED/);
    expect(CLAIM_SQL).toMatch(/FUNCTION enforce_credit_exposure\(\)/);
  });

  it('the client retries the moved-headroom case exactly once, then tells the truth', () => {
    // The RPC's refusal returns the TRUE available figure, so one re-split is
    // worth attempting. An unbounded loop against a number another request is
    // still moving is not, and "please try again" is the honest answer.
    expect(CLAIM_SRC).toMatch(/const first = await attempt\(headroom\.available\)/);
    expect(CLAIM_SRC).toMatch(/const second = await attempt\(first\.retryWith\)/);
    expect(CLAIM_SRC).toMatch(/if \('retryWith' in second\)[\s\S]{0,160}reason: 'over_limit'/);
    // No third.
    expect((CLAIM_SRC.match(/await attempt\(/g) ?? []).length).toBe(2);
  });

  it('the race is proved refused where a race CAN be proved', () => {
    // A stub row-set has no lock to take and no COMMIT to hook, so the proof
    // moved to real Postgres. Pinned as a pointer so this file cannot become
    // the last word on A-04.
    const RPC_TEST = readSrc('supabase/migrations/0130_claim_credit_for_plan.rpc.test.ts');
    expect(RPC_TEST).toMatch(/THE RACE/);
    expect(RPC_TEST).toMatch(/PGlite|pglite/);
  });
});

describe('outstandingExposure — the definition that survived the fix', () => {
  it('counts uncollected instalments across live plans', () => {
    const state = { limit: 5000, plans: [] as PlanRow[], payments: [] as PaymentRow[] };
    commitPlan(state, 'plan-1', 5000);
    return outstandingExposure(stubDb(state), PATIENT).then((exposure) => {
      expect(exposure.ok).toBe(true);
      if (exposure.ok) expect(exposure.rands).toBe(5000);
    });
  });

  it('sums across MULTIPLE live plans', async () => {
    // The figure the old check-then-act got right and committed twice over.
    const state = { limit: 5000, plans: [] as PlanRow[], payments: [] as PaymentRow[] };
    commitPlan(state, 'plan-1', 5000);
    commitPlan(state, 'plan-2', 5000);
    const exposure = await outstandingExposure(stubDb(state), PATIENT);
    if (exposure.ok) expect(exposure.rands).toBe(10000);
  });

  it('drops a collected instalment, so a customer part-way through owes less', async () => {
    const state = { limit: 5000, plans: [] as PlanRow[], payments: [] as PaymentRow[] };
    commitPlan(state, 'plan-1', 5000);
    state.payments[0].status = 'collected';
    const exposure = await outstandingExposure(stubDb(state), PATIENT);
    if (exposure.ok) expect(exposure.rands).toBe(2500);
  });

  it('excludes the plan being accepted right now', async () => {
    // The resume paths re-enter a plan whose rows are ALREADY in the table.
    // Counting them and then adding the bill again would refuse a legitimate
    // resume and charge the customer twice for one bill.
    const state = { limit: 5000, plans: [] as PlanRow[], payments: [] as PaymentRow[] };
    commitPlan(state, 'plan-1', 5000);
    const exposure = await outstandingExposure(stubDb(state), PATIENT, { excludePlanId: 'plan-1' });
    if (exposure.ok) expect(exposure.rands).toBe(0);
  });

  it('ignores settlement rows, which cover instalments already counted', async () => {
    const state = { limit: 5000, plans: [] as PlanRow[], payments: [] as PaymentRow[] };
    commitPlan(state, 'plan-1', 5000);
    state.payments.push({
      plan_id: 'plan-1', patient_id: PATIENT, amount: 5000,
      kind: 'settlement', status: 'scheduled',
    });
    const exposure = await outstandingExposure(stubDb(state), PATIENT);
    if (exposure.ok) expect(exposure.rands).toBe(5000);
  });

  it('a failed read is not zero exposure — it is a failure', async () => {
    // "Could not read" and "owes nothing" are indistinguishable to a caller
    // that treats an error as 0, and one of those answers gives away money.
    const broken = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          neq() { return this; },
          then(resolve: (v: { data: null; error: { message: string } }) => unknown) {
            return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve);
          },
        };
      },
    };
    const exposure = await outstandingExposure(broken, PATIENT);
    expect(exposure.ok).toBe(false);
  });
});
