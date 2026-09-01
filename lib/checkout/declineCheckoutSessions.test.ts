import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { declineCheckoutSessionsForPlan, OPEN_CHECKOUT_STAGES } from './declineCheckoutSessions';

// ─── Wiring + contract tests ──────────────────────────────────────────────
//
// The behavioural proof lives in declineCheckoutSessions.pglite.test.ts, which
// runs the real UPDATE against a real Postgres with migration 0085's own CHECK
// constraint. This file covers what a database cannot show:
//
//   • that declinePlan actually calls it, AFTER it has authorised and declined
//     the plan, and does NOT surface a propagation failure to the patient
//   • that the open-stage set stays the exact complement of the terminal set
//     the SQL side already enforces
//   • that the till's copy for the newly-reachable stage says who declined

const ROOT   = resolve(process.cwd());
const read   = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));
const rawRead = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('the open-stage set agrees with the SQL side', () => {
  const MIG = rawRead('supabase/migrations/0085_checkout_sessions.sql').replace(/\r\n/g, '\n');

  it('is exactly the pair expire_stale_checkout_session treats as still-open', () => {
    // The SQL guard is the negative form: `IF v_session.stage NOT IN
    // ('created', 'scanned') THEN RETURN`. Two propagation paths disagreeing
    // about which stages are terminal is how one of them starts overwriting
    // history the other one wrote.
    expect(MIG).toContain("IF v_session.stage NOT IN ('created', 'scanned') THEN");
    expect([...OPEN_CHECKOUT_STAGES]).toEqual(['created', 'scanned']);
  });

  it('excludes every terminal stage the constraint allows', () => {
    for (const terminal of ['completed', 'declined', 'expired']) {
      expect([...OPEN_CHECKOUT_STAGES]).not.toContain(terminal);
    }
  });
});

describe('declinePlan wires the propagation in', () => {
  const ACTIONS = read('app/patient/actions.ts');
  const decline = ACTIONS.slice(ACTIONS.indexOf('export async function declinePlan'));

  it('calls the shared helper rather than inlining a second UPDATE shape', () => {
    expect(decline).toMatch(/declineCheckoutSessionsForPlan\(planId\)/);
    // No hand-rolled session write in the patient action itself.
    expect(decline).not.toMatch(/from\('checkout_sessions'\)/);
  });

  it('propagates only AFTER the plan update has succeeded', () => {
    // Order matters: a session must never read 'declined' for a plan that is
    // still pending, which is the mirror image of the bug being fixed.
    const planUpdate = decline.indexOf("update({ status: 'declined' })");
    const planGuard  = decline.indexOf('if (planError) return');
    const propagate  = decline.indexOf('declineCheckoutSessionsForPlan(planId)');
    expect(planUpdate).toBeGreaterThan(0);
    expect(planGuard).toBeGreaterThan(planUpdate);
    expect(propagate).toBeGreaterThan(planGuard);
  });

  it('keeps its own authorisation ahead of everything — patient + pending_acceptance', () => {
    // Untouched by this change, pinned because the propagation now depends on
    // it: the helper takes a plan id on trust, so the trust has to be earned
    // here.
    const auth   = decline.indexOf('auth.getUser()');
    const scoped = decline.indexOf(".eq('patient_id', user.id)");
    const status = decline.indexOf(".eq('status', 'pending_acceptance')");
    const write  = decline.indexOf("update({ status: 'declined' })");
    expect(auth).toBeGreaterThan(0);
    expect(scoped).toBeGreaterThan(auth);
    expect(status).toBeGreaterThan(auth);
    expect(write).toBeGreaterThan(status);
  });

  it('does NOT turn a propagation failure into a patient-facing error', () => {
    // The decline already happened and cannot be retried (the read above is
    // scoped to pending_acceptance), so reporting failure would be both untrue
    // and a dead end. It logs and returns success, like the completion route's
    // own session-stage write.
    const propagate = decline.indexOf('declineCheckoutSessionsForPlan(planId)');
    const tail      = decline.slice(propagate);
    expect(tail).toMatch(/console\.error\(/);
    expect(tail).not.toMatch(/return \{ error: sessionPropagation/);
    expect(tail).toMatch(/return \{ error: null \}/);
  });

  it('is the only patient-side decline path, so one call site is enough', () => {
    // Three components render a decline control (PendingPlanCard, HomeBillCard,
    // PlanActions) and two pages wire them, but all of them are handed the
    // SAME server action — so the propagation cannot be reached through a
    // second, unpatched route.
    for (const rel of [
      'app/patient/PendingPlanCard.tsx',
      'app/patient/HomeBillCard.tsx',
      'app/patient/PlanActions.tsx',
    ]) {
      const code = read(rel);
      expect(code, rel).toMatch(/declinePlan\(planId\)/);
      expect(code, rel).not.toMatch(/from\('plans'\)/);
    }
    expect(read('app/patient/page.tsx')).toMatch(/declinePlan=\{declinePlan\}/);
    expect(read('app/patient/orders/page.tsx')).toMatch(/declinePlan=\{declinePlan\}/);
  });
});

describe('the helper reports rather than throws', () => {
  it('surfaces a database error as an error field, not an exception', async () => {
    const failing = {
      from: () => ({
        update: () => failing.from(),
        eq:     () => failing.from(),
        in:     () => failing.from(),
        select: async () => ({ data: null, error: { message: 'permission denied' } }),
      }),
    };
    const result = await declineCheckoutSessionsForPlan('plan-1', failing);
    expect(result).toEqual({ closed: 0, error: 'permission denied' });
  });

  it('reads null data as zero rows moved, not as a crash', async () => {
    const nullish = {
      from: () => ({
        update: () => nullish.from(),
        eq:     () => nullish.from(),
        in:     () => nullish.from(),
        select: async () => ({ data: null, error: null }),
      }),
    };
    expect(await declineCheckoutSessionsForPlan('plan-1', nullish)).toEqual({ closed: 0, error: null });
  });

  it('never returns the plan id or any session detail to its caller', async () => {
    // The caller is a patient-facing action. The result shape is deliberately
    // a count and an error string — nothing about a session belongs on a
    // surface the patient can see.
    const one = {
      from: () => ({
        update: () => one.from(),
        eq:     () => one.from(),
        in:     () => one.from(),
        select: async () => ({ data: [{ id: 'sess-1' }], error: null }),
      }),
    };
    const result = await declineCheckoutSessionsForPlan('plan-1', one);
    expect(Object.keys(result).sort()).toEqual(['closed', 'error']);
    expect(JSON.stringify(result)).not.toContain('sess-1');
  });

  it('sends exactly one UPDATE, scoped by plan_id and stage', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const spy = {
      from: (...a: unknown[]) => { calls.push({ method: 'from', args: a }); return spy.builder; },
      builder: {
        update: (...a: unknown[]) => { calls.push({ method: 'update', args: a }); return spy.builder; },
        eq:     (...a: unknown[]) => { calls.push({ method: 'eq',     args: a }); return spy.builder; },
        in:     (...a: unknown[]) => { calls.push({ method: 'in',     args: a }); return spy.builder; },
        select: async (...a: unknown[]) => {
          calls.push({ method: 'select', args: a });
          return { data: [], error: null };
        },
      },
    };
    await declineCheckoutSessionsForPlan('plan-9', spy);

    expect(calls.filter((c) => c.method === 'update')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'from')!.args).toEqual(['checkout_sessions']);
    expect(calls.find((c) => c.method === 'update')!.args).toEqual([{ stage: 'declined' }]);
    expect(calls.find((c) => c.method === 'eq')!.args).toEqual(['plan_id', 'plan-9']);
    expect(calls.find((c) => c.method === 'in')!.args).toEqual(['stage', ['created', 'scanned']]);
  });
});

describe('the till names the newly-reachable stage without blaming the practice', () => {
  const STRIP = read('app/practice/pos/TodayActivityStrip.tsx');

  it('says WHO declined, so it cannot be read as a card decline', () => {
    // "Declined" on its own, at a till, means the card was declined — that is
    // what it means on every card machine in the country, and it calls for a
    // different response from the front desk than "this patient says the bill
    // isn't theirs".
    expect(STRIP).toMatch(/declined:\s*'Patient declined'/);
    expect(STRIP).not.toMatch(/declined:\s*'Declined'/);
  });

  it('the wording states what the patient did, with no fault attached', () => {
    // The rendered words only — the KEYS are stage names the database chose
    // (one of them is literally 'payment_failed'), not copy anyone reads out.
    const detail = STRIP.slice(STRIP.indexOf('const STOPPED_DETAIL'));
    const block  = detail.slice(0, detail.indexOf('};') + 2);
    const words  = [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1].toLowerCase());
    for (const blame of ['failed', 'error', 'rejected', 'invalid', 'wrong', 'refused']) {
      for (const word of words) expect(word, blame).not.toContain(blame);
    }
  });

  it('still lands in the stopped bucket — one honest answer to "did it go through?"', () => {
    const ACTIVITY = read('lib/practice/tillActivity.ts');
    expect(ACTIVITY).toMatch(/declined:\s*'stopped'/);
    expect(ACTIVITY).not.toMatch(/declined:\s*'done'/);
  });

  it('no longer claims the stage is unwritten', () => {
    // The comment that said so was true when it was written and is now the
    // kind of stale note that costs the next person an hour.
    const raw = rawRead('app/practice/pos/TodayActivityStrip.tsx');
    expect(raw).not.toMatch(/nothing in the product writes it/);
  });
});

describe('the reachability of this path, stated honestly', () => {
  it('declinePlan requires a plan bound to the patient AND still pending_acceptance', () => {
    // Both guards are in the source; together they mean the propagation is
    // dormant for a plan issued at the till and completed normally, because
    // initiateCheckout binds patient_id and moves the plan to
    // pending_first_payment in the same action. See the task report — the
    // reachable windows are (a) a failure between those two writes and (b) any
    // future flow that binds a patient to a still-pending till plan. Pinned so
    // that if someone widens declinePlan's status scope, they meet this note.
    const ACTIONS = read('app/patient/actions.ts');
    const decline = ACTIONS.slice(ACTIONS.indexOf('export async function declinePlan'));
    expect(decline).toMatch(/\.eq\('status', 'pending_acceptance'\)/);
    expect(decline).toMatch(/\.eq\('patient_id', user\.id\)/);
  });

  it('initiateCheckout is what binds a till plan, and it leaves pending_acceptance in the same action', () => {
    // Since migration 0130 the pending_acceptance → pending_first_payment
    // transition is written by claim_credit_for_plan rather than by an UPDATE
    // in this action (audit A-04 — the transition and the schedule insert had
    // to become one transaction). The ORDERING is the property this test cares
    // about and it is unchanged: bind first, then leave pending_acceptance.
    const CHECKOUT = read('app/checkout/[token]/actions.ts');
    const initiate = CHECKOUT.slice(CHECKOUT.indexOf('export async function initiateCheckout'));
    const bind  = initiate.indexOf("update({ patient_id: userId })");
    const claim = initiate.indexOf('claimCreditForPlan(svc, {');
    expect(bind).toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(bind);
    const SQL = rawRead('supabase/migrations/0130_claim_credit_for_plan.sql');
    expect(SQL).toMatch(/UPDATE plans\s+SET status\s+= 'pending_first_payment'/);
  });

  it('nothing else writes a session stage, so there is no third path to keep in step', () => {
    const writers = [
      // The completion route.
      read('app/checkout/[token]/complete/page.tsx'),
      // The SQL fail-safe.
      rawRead('supabase/migrations/0085_checkout_sessions.sql'),
      // This module — now parameterised over the stage, since the webhook's
      // payment_failed propagation shares the same predicate.
      read('lib/checkout/declineCheckoutSessions.ts'),
    ];
    expect(writers[0]).toMatch(/update\(\{ stage: 'completed' \}\)/);
    expect(writers[1]).toMatch(/SET stage\s+= 'expired'/);
    expect(writers[2]).toMatch(/update\(\{ stage \}\)/);
    expect(writers[2]).toMatch(/closeOpenSessionsForPlan\(planId, 'declined'/);
  });
});
