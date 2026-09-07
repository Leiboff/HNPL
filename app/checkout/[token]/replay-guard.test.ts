import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── The checkout replay guard (audit 2026-09-01, F-06) ─────────────────
//
// initiateCheckout deletes the plan's payment schedule and writes a fresh
// one. That is legitimate — it is how a patient who abandoned at the
// widget comes back and switches 2↔3 — and it was guarded only by a
// DENY-LIST of completed/cancelled/declined. `active` sailed through, so
// an already-paid, already-paid-out plan could be reset to
// pending_first_payment with its collected instalment deleted, and then
// cancelled by letting the next card decline. The payouts row is UNIQUE on
// plan_id and is never reversed, so the practice kept its 94%.
//
// ─── Why this file is source assertions rather than a behavioural test ──
//
// initiateCheckout is ~450 lines that create an auth user, call Peach,
// sign a session in and set cookies. Standing all of that up would test
// the mocks. What actually has to hold is a small set of structural facts
// about the guard, and those are what this pins.
//
// ─── The distinction that was nearly got wrong ──────────────────────────
//
// A first pass at the fix refused any plan with a 'processing' payment
// row. That reads sensible and is wrong: 'processing' is the status
// initiateCheckout ITSELF writes for instalment 1, so every genuine
// abandoner is sitting in it, and refusing on it would have broken the one
// re-entry the action exists to support.
//
// What makes admitting it safe is the pairing with peach_registration_id:
// a CIT that actually landed stamps that id on BOTH completion paths (the
// browser return page and the webhook), so "no registration id and nothing
// collected" is a charge that demonstrably did not complete, whatever the
// row still says. Both halves are asserted below, because either one alone
// is either a hole or a broken flow.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));
// SQL keeps its comments — stripComments is a TS/JS stripper, and the SQL
// assertions below quote statements, not prose.
const rawRead = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const ACTIONS  = read('app/checkout/[token]/actions.ts');
const ACTIVATE = read('lib/payments/activateFirstInstalment.ts');
const COMPLETE = read('app/checkout/[token]/complete/page.tsx');

/** The body of initiateCheckout, up to the next exported function. */
function initiateCheckoutBody(): string {
  const start = ACTIONS.indexOf('export async function initiateCheckout');
  expect(start).toBeGreaterThan(-1);
  const next = ACTIONS.indexOf('export async function', start + 1);
  return ACTIONS.slice(start, next === -1 ? undefined : next);
}

describe('initiateCheckout admits only the two states it can safely rewrite', () => {
  const body = initiateCheckoutBody();

  it('uses an ALLOW-list of plan statuses, not a deny-list', () => {
    expect(body).toMatch(/ACCEPTABLE_ENTRY_STATES/);
    expect(body).toMatch(/'pending_acceptance',\s*'pending_first_payment'/);
    expect(body).toMatch(/!ACCEPTABLE_ENTRY_STATES\.includes/);
  });

  it('does not admit an active plan — the F-06 exploit', () => {
    // The old guard named three terminal statuses and let everything else
    // through. If this regresses to a deny-list, `active` is back in.
    const denyList = /plan\.status === 'completed'\s*\|\|\s*plan\.status === 'cancelled'/;
    expect(body).not.toMatch(denyList);
    expect(body).not.toMatch(/ACCEPTABLE_ENTRY_STATES[^;]*'active'/);
  });

  it('refuses a pending_first_payment plan that already captured a card', () => {
    expect(body).toMatch(/plan\.status === 'pending_first_payment'/);
    expect(body).toMatch(/if \(plan\.peach_registration_id\)/);
  });

  it('selects peach_registration_id, or the check above reads undefined', () => {
    // The guard is only as good as the column being fetched. Before this
    // fix the select did not include it.
    const select = body.slice(body.indexOf(".from('plans')"));
    expect(select.slice(0, 400)).toMatch(/peach_registration_id/);
  });
});

describe('a settled instalment is never deleted', () => {
  const body = initiateCheckoutBody();
  // Since migration 0130 the schedule write is one transaction inside
  // claim_credit_for_plan (audit A-04), so the scoped delete and the survivor
  // refusal moved out of this action and into the RPC. They are the SAME two
  // properties, asserted where they now live — the F-06 lesson is a property
  // of the statement that writes a schedule, wherever that statement is.
  const CLAIM_SQL = rawRead('supabase/migrations/0130_claim_credit_for_plan.sql');

  it('refuses on a collected or defaulted row', () => {
    expect(body).toMatch(/\.in\('status', \['collected', 'defaulted'\]\)/);
  });

  it('does NOT refuse on processing — that is the abandoner it must admit', () => {
    // Pinned as a negative because the sensible-looking mistake is to add
    // it. See the file header for why it is safe to admit.
    expect(body).not.toMatch(/\.in\('status', \['collected', 'processing'\]\)/);
  });

  it('scopes the schedule delete to the never-settled statuses', () => {
    expect(CLAIM_SQL).toMatch(
      /DELETE FROM payments\s+WHERE plan_id = p_plan_id\s+AND status IN \('scheduled', 'processing', 'failed'\)/,
    );
    // And this action no longer deletes payments at all — the RPC is the one
    // writer, which is what makes the guard unbypassable rather than repeated.
    expect(body).not.toMatch(/from\('payments'\)[\s\S]{0,80}\.delete\(\)/);
  });

  it('never issues an unscoped delete on the plan\'s payments', () => {
    // The original line was `.delete().eq('plan_id', plan.id)` with no
    // status filter at all.
    expect(body).not.toMatch(/\.delete\(\)\s*\.eq\('plan_id', plan\.id\);/);
  });

  it('refuses if anything survives the scoped delete', () => {
    expect(CLAIM_SQL).toMatch(/SELECT COUNT\(\*\) INTO v_survivors FROM payments WHERE plan_id = p_plan_id/);
    expect(CLAIM_SQL).toMatch(/IF v_survivors > 0 THEN[\s\S]{0,300}'schedule_survived'/);
    // Inside the same transaction as the delete and the insert, so unlike the
    // old TypeScript version there is no window in which the refusal loses a
    // race with a concurrent settlement.
    expect(CLAIM_SQL.indexOf('DELETE FROM payments'))
      .toBeLessThan(CLAIM_SQL.indexOf('INTO v_survivors'));
    expect(CLAIM_SQL.indexOf('INTO v_survivors'))
      .toBeLessThan(CLAIM_SQL.indexOf('INSERT INTO payments'));
  });
});

describe('activation closes the token, on every path', () => {
  // The exploit needed a live token on an activated plan. Closing the
  // token used to happen only on the browser return pages, so a
  // webhook-activated plan (tab closed, signal lost, back pressed) left
  // one open for the rest of its seven-day TTL.

  it('activateFirstInstalment stamps the invitation accepted', () => {
    expect(ACTIVATE).toMatch(/closeCheckoutTokensForPlan/);
    expect(ACTIVATE).toMatch(/from\('patient_invitations'\)[\s\S]{0,200}accepted_at/);
    expect(ACTIVATE).toMatch(/\.is\('accepted_at', null\)/);
  });

  it('activateFirstInstalment advances the counter session', () => {
    expect(ACTIVATE).toMatch(/from\('checkout_sessions'\)[\s\S]{0,160}stage: 'completed'/);
    expect(ACTIVATE).toMatch(/\.neq\('stage', 'completed'\)/);
  });

  it('runs on EVERY invocation, not only the one that creates the payout', () => {
    // WHAT THIS GUARDS, AND WHY IT NOW READS THE SQL
    //
    // A failed close is non-fatal and only logs, so it is a LATER call that
    // has to retry it. The close therefore must not sit behind an early
    // return that a repeat caller takes — when it did, only the first caller
    // to reach the payout block ever closed the token and the window stayed
    // open with an ALERT line as its only trace.
    //
    // The old shape of that hazard was the payout existence fast-path, which
    // returned early once a payout existed; the assertion was that the close
    // came first in the file. Ordering no longer answers the question,
    // because the payout branch is inside activate_first_instalment (0151)
    // and the only early returns left in the TypeScript are the RPC's own
    // failure paths. So the question becomes what a repeat call gets BACK
    // from the RPC, and that is what is pinned here.
    const closeIdx = ACTIVATE.indexOf('await closeCheckoutTokensForPlan');
    expect(closeIdx).toBeGreaterThan(-1);

    // Nothing between a successful RPC and the close: no re-read of the
    // payout, no branch, no early return.
    const okIdx = ACTIVATE.indexOf('if (!outcome?.ok)');
    expect(okIdx).toBeGreaterThan(-1);
    expect(okIdx).toBeLessThan(closeIdx);
    const between = ACTIVATE.slice(ACTIVATE.indexOf('}', okIdx), closeIdx);
    expect(between).not.toMatch(/\breturn\b/);

    // …and a second, third or fourth call still gets ok back, so it still
    // reaches the close. Every state a first call leaves behind is in the
    // acceptance lists, and the duplicate payout is absorbed rather than
    // raised as an error.
    const activateSql = rawRead('supabase/migrations/0151_atomic_first_instalment_activation.sql');
    expect(activateSql).toMatch(/v_plan\.status NOT IN \('pending_first_payment', 'active'\)/);
    expect(activateSql).toMatch(/v_payment\.status NOT IN \('processing', 'collected'\)/);
    expect(activateSql).toMatch(/ON CONFLICT \(plan_id\) DO NOTHING/);
  });

  it('cannot throw out into the ledger writes around it', () => {
    expect(ACTIVATE).toMatch(/async function closeCheckoutTokensForPlan[\s\S]*?try \{/);
    expect(ACTIVATE).toMatch(/token close threw \(non-fatal\)/);
  });
});

describe('the completion page is bound to its own token (F-07)', () => {
  it('resolves the path token and compares it to the payment\'s plan', () => {
    expect(COMPLETE).toMatch(/resolveTokenPlan\(svc, token\)/);
    expect(COMPLETE).toMatch(/resolved\.planId !== planId/);
  });

  it('never resets the patient\'s password to establish a session', () => {
    // The old fallback called admin.updateUserById({ password }) and then
    // signed in with the value it had just written — rotating the
    // credential of whoever the checkoutId happened to belong to.
    expect(COMPLETE).not.toMatch(/updateUserById\([^)]*password/);
    expect(COMPLETE).not.toMatch(/signInWithPassword/);
    expect(COMPLETE).toMatch(/generateLink/);
  });

  it('refuses rather than switching an already-signed-in different user', () => {
    expect(COMPLETE).toMatch(/user && user\.id !== patientId/);
    expect(COMPLETE).toMatch(/not switching accounts/);
  });

  it('does not tell a patient whose payment succeeded that it failed', () => {
    // Both new refusals happen AFTER a successful charge. The card they
    // reuse defaults to "the bill is still unpaid — try again", which
    // would produce exactly the duplicate payment it is refusing to
    // enable. Pinned because the default is the easy thing to reach for.
    expect(COMPLETE).toMatch(/showRetry=\{false\}/);
    expect(COMPLETE).toMatch(/Don't pay a second time/);
    expect(COMPLETE).toMatch(/Your payment went through and the plan is active/);
  });
});
