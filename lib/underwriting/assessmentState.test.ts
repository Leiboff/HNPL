import { describe, it, expect, vi } from 'vitest';
import {
  addMonths,
  isStale,
  isInCooldown,
  cooldownFrom,
  expiresAt,
  gatePlanRequest,
  requiresNoBureauCall,
  statusForOutcome,
  type AssessmentSnapshot,
} from './assessmentState';
import { handlePlanRequest, reassess } from './pipeline';
import { buildAssessmentRow } from './assessmentStore';
import { parseGetScoreResponse } from '@/lib/experian/scoreClient';
import { parseAffordabilityResponse } from '@/lib/experian/affordabilityClient';
import { SIGMA_BANDS } from '@/lib/experian/bands';
import { DEFAULT_SCORECARD_PREFERENCE } from '@/lib/experian/config';
import * as score from '@/lib/experian/__fixtures__/score';
import * as afford from '@/lib/experian/__fixtures__/affordability';

const NOW = new Date('2026-09-03T12:00:00Z');
const ID  = score.FIXTURE_ID;

function snapshot(over: Partial<AssessmentSnapshot> = {}): AssessmentSnapshot {
  return {
    limit: 10_000,
    assessedAt: '2026-08-01T00:00:00Z',
    status: 'active',
    cooldownUntil: null,
    band: 'low',
    ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    score:          vi.fn(async () => parseGetScoreResponse(score.SCORE_SUCCESS_SU_SCORED_660)),
    affordability:  vi.fn(async () => parseAffordabilityResponse(afford.AFFORD_SUCCESS_HIGH)),
    identityStatus: vi.fn(async () => 'passed' as const),
    preference: [...DEFAULT_SCORECARD_PREFERENCE],
    cards: SIGMA_BANDS,
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════════
//  REQUIRED TEST 3
//  A patient with a valid, unexpired limit starting a second plan makes
//  ZERO Experian calls.
// ════════════════════════════════════════════════════════════════════════

describe('REQUIRED: a second plan on a valid limit makes zero Experian calls', () => {
  it('calls neither bureau client', async () => {
    const d = deps();

    const outcome = await handlePlanRequest(d, snapshot(), NOW, { idNumber: ID, declared: null });

    expect(outcome.kind).toBe('allowed');
    expect(outcome.kind === 'allowed' && outcome.limit).toBe(10_000);
    expect(d.score).not.toHaveBeenCalled();
    expect(d.affordability).not.toHaveBeenCalled();
  });

  it('holds for a third, fourth and fifth plan too', async () => {
    const d = deps();
    for (let i = 0; i < 5; i += 1) {
      await handlePlanRequest(d, snapshot(), NOW, { idNumber: ID, declared: null });
    }
    expect(d.score).not.toHaveBeenCalled();
    expect(d.affordability).not.toHaveBeenCalled();
  });

  it('holds right up to the moment the limit expires', async () => {
    const d = deps();
    const assessed = '2026-03-03T12:00:00Z';
    // Six months less a second.
    const justInside = new Date('2026-09-03T11:59:59Z');

    const outcome = await handlePlanRequest(
      d, snapshot({ assessedAt: assessed }), justInside, { idNumber: ID, declared: null });

    expect(outcome.kind).toBe('allowed');
    expect(d.score).not.toHaveBeenCalled();
  });

  it('does not even read the identity status — nothing is consulted', async () => {
    const d = deps();
    await handlePlanRequest(d, snapshot(), NOW, { idNumber: ID, declared: null });
    expect(d.identityStatus).not.toHaveBeenCalled();
  });
});

// ─── Staleness ──────────────────────────────────────────────────────────

describe('an expired limit triggers re-assessment, not a decline', () => {
  it('re-assesses once the window has passed', async () => {
    const d = deps();
    const outcome = await handlePlanRequest(
      d, snapshot({ assessedAt: '2026-01-01T00:00:00Z' }), NOW, { idNumber: ID, declared: null });

    expect(outcome.kind).toBe('reassessed');
    expect(outcome.kind === 'reassessed' && outcome.reason).toBe('stale');
    expect(d.score).toHaveBeenCalledTimes(1);
  });

  it('is emphatically not a refusal', async () => {
    const outcome = await handlePlanRequest(
      deps(), snapshot({ assessedAt: '2026-01-01T00:00:00Z' }), NOW,
      { idNumber: ID, declared: null });

    expect(outcome.kind).not.toBe('blocked');
    if (outcome.kind !== 'reassessed') throw new Error('expected a re-assessment');
    expect(outcome.result.kind).toBe('assessed');
  });

  it('the window is exactly six months by default', () => {
    const snap = snapshot({ assessedAt: '2026-03-03T12:00:00Z' });
    expect(expiresAt(snap)!.toISOString()).toBe('2026-09-03T12:00:00.000Z');
    expect(isStale(snap, new Date('2026-09-03T11:59:59Z'))).toBe(false);
    expect(isStale(snap, new Date('2026-09-03T12:00:00Z'))).toBe(true);
  });

  it('honours a configured window', async () => {
    const d = deps();
    const outcome = await handlePlanRequest(
      d, snapshot({ assessedAt: '2026-08-01T00:00:00Z' }), NOW,
      { idNumber: ID, declared: null, stalenessMonths: 1 });
    expect(outcome.kind).toBe('reassessed');
  });

  it('a patient with no assessment at all is re-assessed, not refused', async () => {
    const outcome = await handlePlanRequest(
      deps(), snapshot({ limit: null, assessedAt: null, status: null }), NOW,
      { idNumber: ID, declared: null });
    expect(outcome.kind).toBe('reassessed');
    expect(outcome.kind === 'reassessed' && outcome.reason).toBe('no_assessment');
  });
});

// ─── Cooldown ───────────────────────────────────────────────────────────

describe('a declined patient inside cooldown cannot re-trigger enquiries', () => {
  it('makes zero bureau calls and reports when it lifts', async () => {
    const d = deps();
    const until = '2026-12-01T00:00:00Z';

    const outcome = await handlePlanRequest(
      d, snapshot({ status: 'declined', cooldownUntil: until }), NOW,
      { idNumber: ID, declared: null });

    expect(outcome.kind).toBe('blocked');
    expect(outcome.kind === 'blocked' && outcome.until.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(d.score).not.toHaveBeenCalled();
    expect(d.affordability).not.toHaveBeenCalled();
  });

  it('the cooldown outranks an increase request and an admin trigger', async () => {
    // Otherwise "request an increase" is a free bypass of the whole control.
    const d = deps();
    const snap = snapshot({ status: 'declined', cooldownUntil: '2026-12-01T00:00:00Z' });

    for (const opts of [{ requestedIncrease: true }, { adminTriggered: true }]) {
      const outcome = await handlePlanRequest(d, snap, NOW, { idNumber: ID, declared: null, ...opts });
      expect(outcome.kind).toBe('blocked');
    }
    expect(d.score).not.toHaveBeenCalled();
  });

  it('lifts on expiry and allows a fresh assessment', async () => {
    const d = deps();
    const outcome = await handlePlanRequest(
      d, snapshot({ status: 'declined', cooldownUntil: '2026-08-01T00:00:00Z' }), NOW,
      { idNumber: ID, declared: null });

    expect(outcome.kind).toBe('reassessed');
    expect(d.score).toHaveBeenCalledTimes(1);
  });

  it('defaults to three months from the decline', () => {
    expect(cooldownFrom(new Date('2026-09-03T12:00:00Z')).toISOString())
      .toBe('2026-12-03T12:00:00.000Z');
  });

  it('is only set by a substantive decline, never by a pending assessment', () => {
    // A patient we could not assess is not refused and must not be locked
    // out because a SOAP endpoint was briefly unavailable.
    expect(statusForOutcome('pending')).toBe('pending');
    expect(statusForOutcome('declined')).toBe('declined');
    expect(isInCooldown(snapshot({ status: 'pending', cooldownUntil: null }), NOW)).toBe(false);
  });

  it('a pending assessment reports pending and spends nothing', async () => {
    const d = deps();
    const outcome = await handlePlanRequest(
      d, snapshot({ status: 'pending' }), NOW, { idNumber: ID, declared: null });

    expect(outcome.kind).toBe('pending_assessment');
    expect(d.score).not.toHaveBeenCalled();
  });
});

// ─── Explicit re-assessment triggers ────────────────────────────────────

describe('all three triggers run the one path', () => {
  it.each([
    ['increase_request', { requestedIncrease: true }],
    ['admin',            { adminTriggered: true }],
  ] as const)('%s re-assesses even on a valid limit', async (reason, opts) => {
    const d = deps();
    const outcome = await handlePlanRequest(d, snapshot(), NOW, { idNumber: ID, declared: null, ...opts });

    expect(outcome.kind).toBe('reassessed');
    expect(outcome.kind === 'reassessed' && outcome.reason).toBe(reason);
    expect(d.score).toHaveBeenCalledTimes(1);
  });

  it('re-assessment includes the score gate', async () => {
    // A band that has dropped below average risk must not keep drawing on
    // a stale limit.
    const d = deps({
      score: vi.fn(async () => parseGetScoreResponse(score.SCORE_SUCCESS_SU_VERY_HIGH)),
    });

    const result = await reassess(d, { idNumber: ID, declared: null });

    expect(result.kind).toBe('declined');
    expect(d.affordability).not.toHaveBeenCalled();
  });

  it('re-assessment does NOT re-purchase identity, but does check it', async () => {
    const d = deps();
    await reassess(d, { idNumber: ID, declared: null });
    expect(d.identityStatus).toHaveBeenCalledTimes(1);
  });

  it('a revoked identity stops a re-assessment before the affordability spend', async () => {
    const d = deps({ identityStatus: vi.fn(async () => 'failed' as const) });
    const result = await reassess(d, { idNumber: ID, declared: null });

    expect(result.kind).toBe('identity_not_passed');
    expect(d.affordability).not.toHaveBeenCalled();
  });
});

describe('a band drop reduces the limit but leaves plans in flight alone', () => {
  it('produces a lower limit without touching anything else', async () => {
    // Average risk caps at R3,000 where Low caps at R10,000. The new figure
    // binds the NEXT request; existing plans keep running against the limit
    // they were written under, which is why re-assessment returns a limit
    // and writes nothing to plans.
    const dropped = deps({
      score: vi.fn(async () => parseGetScoreResponse(
        score.scoreReplyWith([{ resultType: 'SU', score: '645' }]))), // 638-651 = average
    });

    const result = await reassess(dropped, { idNumber: ID, declared: null });

    expect(result.kind).toBe('assessed');
    if (result.kind !== 'assessed') return;
    expect(result.band).toBe('average');
    expect(result.limit.decision === 'approved' && result.limit.limit).toBe(3_000);
  });

  it('re-assessment returns a decision and never writes to plans itself', async () => {
    // Structural: ReassessResult carries a limit, not a plan mutation.
    const result = await reassess(deps(), { idNumber: ID, declared: null });
    expect(result).not.toHaveProperty('plansUpdated');
    expect(result).not.toHaveProperty('cancelledPlans');
  });
});

// ─── Date arithmetic ────────────────────────────────────────────────────

describe('addMonths clamps rather than overflowing', () => {
  it('31 January plus one month is the last day of February', () => {
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString())
      .toBe('2026-02-28T00:00:00.000Z');
  });

  it('handles a leap February', () => {
    expect(addMonths(new Date('2028-01-31T00:00:00Z'), 1).toISOString())
      .toBe('2028-02-29T00:00:00.000Z');
  });

  it('crosses a year boundary without producing month 13', () => {
    expect(addMonths(new Date('2026-11-15T00:00:00Z'), 3).toISOString())
      .toBe('2027-02-15T00:00:00.000Z');
    expect(addMonths(new Date('2026-10-01T00:00:00Z'), 6).toISOString())
      .toBe('2027-04-01T00:00:00.000Z');
  });

  it('preserves the time of day', () => {
    expect(addMonths(new Date('2026-01-15T13:45:30Z'), 2).toISOString())
      .toBe('2026-03-15T13:45:30.000Z');
  });
});

// ─── The gate, directly ─────────────────────────────────────────────────

describe('gatePlanRequest', () => {
  it('reports which outcomes require no bureau call', () => {
    expect(requiresNoBureauCall(gatePlanRequest(snapshot(), NOW))).toBe(true);
    expect(requiresNoBureauCall(
      gatePlanRequest(snapshot({ status: 'declined', cooldownUntil: '2026-12-01' }), NOW))).toBe(true);
    expect(requiresNoBureauCall(gatePlanRequest(snapshot({ status: 'pending' }), NOW))).toBe(true);
    expect(requiresNoBureauCall(
      gatePlanRequest(snapshot({ assessedAt: '2020-01-01' }), NOW))).toBe(false);
  });

  it('an explicitly expired status re-assesses even inside the window', () => {
    const gate = gatePlanRequest(snapshot({ status: 'expired' }), NOW);
    expect(gate.kind).toBe('reassess');
  });

  it('a malformed timestamp does not silently read as fresh', () => {
    const gate = gatePlanRequest(snapshot({ assessedAt: 'not-a-date' }), NOW);
    expect(gate.kind).toBe('reassess');
  });
});

// ─── The re-assessment row has to be as complete as the first one ───────

describe('a re-assessment logs the same fields a first assessment does', () => {
  it('carries the affordability figures through, not just the limit', async () => {
    // Dropping the resolution here logs NULL for GMIP_Value,
    // Bureau_Expenses, Calc_Living_Expenses, Disposable_Income and the
    // enquiry id — on every re-assessment, which is a growing share of all
    // of them as the book ages. The row would still look present in a
    // count and be useless in a join.
    const result = await reassess(deps(), { idNumber: ID, declared: null });

    expect(result.kind).toBe('assessed');
    if (result.kind !== 'assessed') return;
    expect(result.resolution.kind).toBe('ready');
    if (result.resolution.kind !== 'ready') return;
    expect(result.resolution.data?.gmipValue).toBe(30_000);
    expect(result.resolution.data?.enqId).toBe('ENQ-1000001');
    expect(result.resolution.data?.disposableIncome).toBe(17_200);
  });

  it('builds a complete log row from a re-assessment', async () => {
    const result = await reassess(deps(), { idNumber: ID, declared: null });
    if (result.kind !== 'assessed') throw new Error('expected an assessment');

    const row = buildAssessmentRow({
      patientId: 'p1',
      saIdLookupHash: 'h',
      trigger: 'staleness',
      scoreFamilyLabel: 'Sigma',
      scoreDecision: result.scoreDecision,
      resolution: result.resolution,
      limit: result.limit,
      declaredIncome: null,
    });

    expect(row.trigger).toBe('staleness');
    expect(row.gmip_value).toBe(30_000);
    expect(row.enq_id).toBe('ENQ-1000001');
    expect(row.experian_disposable_income).toBe(17_200);
    expect(row.bureau_expenses).toBe(2_000);
    expect(row.final_limit).toBe(10_000);
  });
});
