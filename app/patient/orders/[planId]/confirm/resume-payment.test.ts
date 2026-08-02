import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Portal resume for an abandoned saved-card CIT one-click ────────
//
// The saved-card first instalment is a customer-present Checkout V2
// one-click (payWithSavedCard). If the patient abandons the widget /
// drops 3DS, the plan is left at pending_first_payment with NO stored
// registration and NO money taken. These pins prove the resume path:
//
//   1. payWithSavedCard is idempotent-resumable — it accepts a
//      pending_first_payment plan, REUSES the existing instalment-1 row
//      (and therefore the SAME deterministic ref), creates NO new rows,
//      changes NO plan status, and NEVER rolls the plan back. Peach
//      dedups on the identical merchantTransactionId → no double charge.
//   2. The confirm page surfaces the resume (accepts pending_first_
//      payment, excludes the plan from its own block check, passes
//      resumeMode) and refuses to resume a plan that already captured a
//      card.
//   3. OrdersView offers a "Resume payment" affordance for exactly the
//      abandoned state (pending_first_payment + no registration).
//
// Source-text pins — cheap regression tripwires on the resume contract.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const ACTIONS       = read('app/patient/actions.ts');
const CONFIRM_PAGE  = read('app/patient/orders/[planId]/confirm/page.tsx');
const CONFIRM_FORM  = read('app/patient/orders/[planId]/confirm/ConfirmForm.tsx');
const ORDERS_VIEW   = read('app/patient/orders/OrdersView.tsx');
const ORDERS_PAGE   = read('app/patient/orders/page.tsx');

// ─── 1. payWithSavedCard — idempotent resume ───────────────────────

describe('payWithSavedCard — resume of an abandoned first charge', () => {
  const fnStart = ACTIONS.indexOf('export async function payWithSavedCard');
  const fnEnd   = ACTIONS.indexOf('export async function', fnStart + 1);
  const body    = ACTIONS.slice(fnStart, fnEnd === -1 ? ACTIONS.length : fnEnd);

  it('accepts BOTH pending_acceptance (fresh) and pending_first_payment (resume)', () => {
    expect(body).toMatch(/\.in\(\s*'status',\s*\[\s*'pending_acceptance',\s*'pending_first_payment'\s*\]\s*\)/);
    expect(body).toContain("const isResume = plan.status === 'pending_first_payment'");
  });

  it('refuses to resume a plan that already captured a card (has a registration)', () => {
    expect(body).toMatch(/isResume\s*&&\s*plan\.peach_registration_id/);
  });

  it('reuses the EXISTING instalment-1 row on resume (no new id → same deterministic ref)', () => {
    // The whole point of idempotency: the ref is checkoutRef(instalment1Id),
    // and on resume instalment1Id is the row that already exists, so the
    // merchantTransactionId is byte-identical and Peach dedups.
    expect(body).toMatch(/if\s*\(isResume\)\s*\{[\s\S]*?\.eq\('instalment_number',\s*1\)[\s\S]*?instalment1Id\s*=\s*existing\.id/);
    expect(body).toContain('const reference = checkoutRef(instalment1Id)');
  });

  it('creates NO new payment rows and changes NO plan status on resume', () => {
    // STEP 1 (plan → pending_first_payment) + STEP 2 (insert rows) run
    // only for a fresh acceptance.
    expect(body).toMatch(/if\s*\(!isResume\)\s*\{[\s\S]*?STEP 1 PLAN UPDATE[\s\S]*?STEP 2 PAYMENTS INSERT/);
    // The resume branch only re-stamps the (same) ref.
    expect(body).toContain('PEACH PAY-WITH-SAVED-CARD RESUME REF STAMP');
  });

  it('never rolls a resume back (would destroy a legitimate in-progress plan)', () => {
    const rbStart = body.indexOf('async function rollbackPlanState');
    const rb      = body.slice(rbStart, rbStart + 600);
    expect(rb).toMatch(/if\s*\(isResume\)/);
    expect(rb).toContain('ROLLBACK SKIPPED (resume)');
  });

  it('skips the new-plan block check on a resume (a plan cannot block itself)', () => {
    expect(body).toMatch(/if\s*\(!isResume\s*&&\s*await isBlockedFromNewPlan/);
  });

  it('still charges via the same one-click CIT surface (createCheckout + cardTokens)', () => {
    expect(body).toContain('provider.createCheckout');
    expect(body).toContain('cardTokens:');
  });
});

// ─── 2. Confirm page — surfaces + guards the resume ────────────────

describe('confirm page — resume wiring', () => {
  it('loads a pending_first_payment plan and passes resumeMode', () => {
    expect(CONFIRM_PAGE).toMatch(/\.in\(\s*'status',\s*\[\s*'pending_acceptance',\s*'pending_first_payment'\s*\]\s*\)/);
    expect(CONFIRM_PAGE).toMatch(/resumeMode\s*=\s*rawPlan\.status === 'pending_first_payment'/);
    expect(CONFIRM_PAGE).toContain('resumeMode={resumeMode}');
  });

  it('redirects away a plan that already captured a card (not resumable)', () => {
    expect(CONFIRM_PAGE).toMatch(/pending_first_payment'\s*&&\s*rawPlan\.peach_registration_id[\s\S]*?redirect\('\/patient\/orders'\)/);
  });

  it('excludes the current plan from its own block check', () => {
    expect(CONFIRM_PAGE).toMatch(/\.neq\('id',\s*planId\)/);
  });

  it('ConfirmForm locks the instalment count + relabels the CTA on resume', () => {
    expect(CONFIRM_FORM).toContain('resumeMode:       boolean');
    expect(CONFIRM_FORM).toMatch(/disabled=\{resumeMode \|\| busy/);
    expect(CONFIRM_FORM).toContain("resumeMode ? 'Resume payment'");
  });
});

// ─── 3. OrdersView — resume affordance for the abandoned state ──────

describe('OrdersView — resume affordance', () => {
  it('renders ResumePaymentCard for pending_first_payment + no registration only', () => {
    expect(ORDERS_VIEW).toMatch(/plan\.status === 'pending_first_payment'\s*&&\s*!plan\.peach_registration_id\s*\?\s*\(\s*<ResumePaymentCard/);
  });

  it('the resume card links to the confirm route', () => {
    expect(ORDERS_VIEW).toMatch(/href=\{`\/patient\/orders\/\$\{plan\.id\}\/confirm`\}/);
    expect(ORDERS_VIEW).toContain('data-testid="resume-payment-link"');
  });

  it('the orders query selects peach_registration_id so resumability is known', () => {
    expect(ORDERS_PAGE).toContain('peach_registration_id');
  });
});
