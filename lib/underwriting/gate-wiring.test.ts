import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── The gates, as wired in the real files ──────────────────────────────
//
// pipeline.test.ts proves the SEQUENCER orders the gates correctly, using
// injected spies. It cannot prove that production actually goes through
// the sequencer — a future edit could call the Experian clients directly
// from an action and every one of those tests would still pass.
//
// So this file pins the wiring itself. Source-text assertions are blunt,
// but the thing being protected is an ordering that costs money when it
// breaks, and the breakage is silent: calling affordability before
// identity produces correct-looking limits and a larger vendor bill.
//
// Comments are stripped first — these files legitimately DISCUSS the
// ordering at length, and a raw scan would match the prose that explains
// the rule rather than the code that implements it.

const ROOT = resolve(process.cwd());
const read = (p: string) =>
  stripComments(readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n'), {
    preserveUrls: true, jsxBraces: true,
  });

const ONBOARDING = read('lib/onboarding/actions.ts');
const PATIENT    = read('app/patient/actions.ts');
const GLUE       = read('lib/onboarding/creditAssessment.ts');
const ADMIN      = read('app/admin/customers/actions.ts');

describe('the score gate guards the identity spend', () => {
  it('submitIdentityForVerification routes the ceremony through the gate', () => {
    expect(ONBOARDING).toMatch(/gateIdentityOnBureauScore<SubmitIdentityResult>\(/);
    expect(ONBOARDING).toMatch(/async function startIdentityCeremony\(\)/);
  });

  it('the billable calls live INSIDE the ceremony, not before it', () => {
    const start = ONBOARDING.indexOf('async function startIdentityCeremony()');
    const gate  = ONBOARDING.indexOf('gateIdentityOnBureauScore<SubmitIdentityResult>(');
    expect(start).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(start);

    const ceremony = ONBOARDING.slice(start, gate);
    // Both paid calls are within the callback the gate decides whether to
    // invoke. If either escapes it, the score stops gating the spend.
    expect(ceremony).toMatch(/resolveIdentityRouteForProvider\(/);
    expect(ceremony).toMatch(/createDhaFaceMatchSession\(/);

    const afterGate = ONBOARDING.slice(gate);
    expect(afterGate).not.toMatch(/resolveIdentityRouteForProvider\(/);
    expect(afterGate).not.toMatch(/createDhaFaceMatchSession\(/);
  });

  it('a declined or pending score returns without reaching the ceremony', () => {
    expect(ONBOARDING).toMatch(/case 'declined':[\s\S]{0,200}SCORE_DECLINE_MESSAGE/);
    expect(ONBOARDING).toMatch(/case 'pending':[\s\S]{0,300}ASSESSMENT_PENDING_MESSAGE/);
    expect(ONBOARDING).toMatch(/case 'blocked':[\s\S]{0,160}cooldownMessage/);
  });

  it('the identity action never calls a bureau client directly', () => {
    expect(ONBOARDING).not.toMatch(/getPersonScore\(/);
    expect(ONBOARDING).not.toMatch(/doAffordability\(/);
  });
});

describe('identity guards the affordability spend', () => {
  it('runCreditCheck goes through assessAffordability, not the client', () => {
    expect(ONBOARDING).toMatch(/assessAffordability\(/);
    expect(ONBOARDING).not.toMatch(/doAffordability\(/);
  });

  it('the glue reads identity before it ever calls affordability', () => {
    // gateAffordabilityOnIdentity takes identityStatus as its first
    // dependency and refuses before the affordability callback. The glue
    // must hand both to it rather than calling the client itself.
    expect(GLUE).toMatch(/gateAffordabilityOnIdentity\(/);
    expect(GLUE).toMatch(/identityStatus:/);
    expect(GLUE).toMatch(/affordability:\s*\(id\) => doAffordability\(id\)/);
  });

  it('runCreditCheck grants no hardcoded amount', () => {
    expect(ONBOARDING).not.toMatch(/approved_credit_limit:\s*\d/);
    expect(ONBOARDING).not.toMatch(/limitCents/);
  });
});

describe('the plan path re-assesses instead of refusing a stale limit', () => {
  it('acceptPlan checks currency before claiming credit', () => {
    const check = PATIENT.indexOf('ensureLimitCurrentForPlan(user.id)');
    const claim = PATIENT.indexOf('claimCreditForPlan(');
    expect(check).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(check);
  });

  it('it runs the one shared path rather than its own pipeline', () => {
    expect(PATIENT).toMatch(/ensureAssessmentCurrent\(/);
    expect(PATIENT).toMatch(/trigger: 'staleness'/);
    // No second implementation: the patient action never touches a client.
    expect(PATIENT).not.toMatch(/getPersonScore\(/);
    expect(PATIENT).not.toMatch(/doAffordability\(/);
  });

  it('is skipped entirely when the flag is off', () => {
    expect(PATIENT).toMatch(/if \(currentFlags\(\)\.creditCheck\) \{\s*const staleness/);
  });
});

describe('all three re-assessment triggers share one path', () => {
  it('staleness, increase request and admin all reach ensureAssessmentCurrent', () => {
    expect(GLUE).toMatch(/requestedIncrease/);
    expect(GLUE).toMatch(/adminTriggered/);
    expect(PATIENT).toMatch(/trigger: 'staleness'/);
    expect(ADMIN).toMatch(/trigger: 'admin'/);
    expect(ADMIN).toMatch(/adminTriggered: true/);
  });

  it('the admin trigger cannot set a limit by hand', () => {
    // A figure typed by a human has no assessment behind it, no
    // coefficient version and no row explaining it — and would be
    // indistinguishable from a priced limit to every gate downstream.
    expect(ADMIN).not.toMatch(/approved_credit_limit/);
    expect(ADMIN).not.toMatch(/update\(\s*\{[^}]*limit/);
  });

  it('the admin trigger is guarded and audited', () => {
    expect(ADMIN).toMatch(/guardAdmin\(\)/);
    expect(ADMIN).toMatch(/recordAdminAction\(/);
    const guard = ADMIN.indexOf('guardAdmin()');
    const spend = ADMIN.indexOf('ensureAssessmentCurrent(');
    expect(guard).toBeLessThan(spend);
  });

  it('the admin trigger cannot bypass the cooldown', () => {
    // handlePlanRequest checks the cooldown BEFORE it honours
    // adminTriggered, so a support-desk button cannot re-run billable
    // enquiries on a declined applicant on demand.
    const PIPELINE = read('lib/underwriting/assessmentState.ts');
    const cooldown = PIPELINE.indexOf('isInCooldown(snapshot, now)');
    const admin    = PIPELINE.indexOf('opts.adminTriggered');
    expect(cooldown).toBeGreaterThan(-1);
    expect(cooldown).toBeLessThan(admin);
  });
});

describe('pending never becomes a decline in the wiring', () => {
  it('the pending message is distinct from the decline message', () => {
    expect(GLUE).toMatch(/SCORE_DECLINE_MESSAGE/);
    expect(GLUE).toMatch(/ASSESSMENT_PENDING_MESSAGE/);
    const decline = read('lib/onboarding/creditAssessment.ts');
    expect(decline).not.toMatch(/ASSESSMENT_PENDING_MESSAGE = SCORE_DECLINE_MESSAGE/);
  });

  it('only the profile update for a decline writes a cooldown', () => {
    const STORE = read('lib/underwriting/assessmentStore.ts');
    const declineBlock = STORE.slice(
      STORE.indexOf("if (row.outcome === 'declined')"),
      STORE.indexOf("if (row.outcome === 'pending')"),
    );
    // Bounded to the end of profileUpdateFor — the reader functions
    // further down the file legitimately name both columns.
    const pendingStart = STORE.indexOf("if (row.outcome === 'pending')");
    const pendingBlock = STORE.slice(pendingStart, STORE.indexOf('return update;', pendingStart));
    expect(declineBlock).toMatch(/credit_decline_cooldown_until/);
    expect(pendingBlock).not.toMatch(/credit_decline_cooldown_until/);
    expect(pendingBlock).not.toMatch(/approved_credit_limit/);
  });

  it('the credit-check UI renders pending as status, not as an error', () => {
    const CLIENT = read('app/onboarding/credit-check/CreditCheckStepClient.tsx');
    expect(CLIENT).toMatch(/role="status"/);
    expect(CLIENT).toMatch(/data-testid="credit-check-pending"/);
    // The pending branch must not reuse the red error class.
    const pendingBranch = CLIENT.slice(CLIENT.indexOf('{pending && ('));
    expect(pendingBranch).not.toMatch(/AUTH_ERROR_CLS/);
  });
});

describe('an assessment already in force is not paid for twice', () => {
  it('runCreditCheck short-circuits on a current approval', () => {
    // A refresh or a double tap would otherwise spend a second billable
    // enquiry to re-derive a limit already on file.
    expect(ONBOARDING).toMatch(/readSnapshot\(svc\(\), loaded\.userId\)/);
    expect(ONBOARDING).toMatch(/existing\.status === 'active'/);
    expect(ONBOARDING).toMatch(/!isStale\(existing, new Date\(\)\)/);
  });

  it('the short-circuit happens BEFORE the affordability call', () => {
    const guard = ONBOARDING.indexOf("existing.status === 'active'");
    const spend = ONBOARDING.indexOf('assessAffordability(');
    expect(guard).toBeGreaterThan(-1);
    expect(spend).toBeGreaterThan(guard);
  });

  it('a stale or declined assessment is NOT reused', () => {
    // Only a current approval short-circuits; everything else falls
    // through to a real assessment.
    const block = ONBOARDING.slice(
      ONBOARDING.indexOf('const existing = await readSnapshot'),
      ONBOARDING.indexOf('assessAffordability('),
    );
    expect(block).toMatch(/existing\.limit !== null/);
    expect(block).toMatch(/!isStale/);
  });
});
