import { describe, it, expect, vi } from 'vitest';
import {
  gateIdentityOnScore,
  gateAffordabilityOnIdentity,
  entersCooldown,
  type IdentityStatus,
} from './pipeline';
import { parseGetScoreResponse } from '@/lib/experian/scoreClient';
import { parseAffordabilityResponse } from '@/lib/experian/affordabilityClient';
import { SIGMA_BANDS } from '@/lib/experian/bands';
import { DEFAULT_SCORECARD_PREFERENCE } from '@/lib/experian/config';
import { declaredGross } from './limit';
import * as score from '@/lib/experian/__fixtures__/score';
import * as afford from '@/lib/experian/__fixtures__/affordability';

const PREF  = [...DEFAULT_SCORECARD_PREFERENCE];
const CARDS = SIGMA_BANDS;
const ID    = score.FIXTURE_ID;

function scoreDeps(xml: string, over: Record<string, unknown> = {}) {
  return {
    score: vi.fn(async () => parseGetScoreResponse(xml)),
    preference: PREF,
    cards: CARDS,
    startIdentity: vi.fn(async () => ({ sessionId: 'didit-1' })),
    ...over,
  };
}

function affordDeps(status: IdentityStatus, xml = afford.AFFORD_SUCCESS_HIGH) {
  return {
    identityStatus: vi.fn(async () => status),
    affordability: vi.fn(async () => parseAffordabilityResponse(xml)),
  };
}

// ════════════════════════════════════════════════════════════════════════
//  REQUIRED TEST 1
//  A below-average-risk score results in ZERO calls to both the identity
//  and the affordability clients.
// ════════════════════════════════════════════════════════════════════════

describe('REQUIRED: a below-average-risk score spends nothing downstream', () => {
  it('makes zero identity calls and zero affordability calls', async () => {
    const deps = scoreDeps(score.SCORE_SUCCESS_SU_VERY_HIGH);
    const affordability = vi.fn();

    const result = await gateIdentityOnScore(deps, ID);

    expect(result.kind).toBe('declined');
    expect(deps.startIdentity).not.toHaveBeenCalled();
    expect(affordability).not.toHaveBeenCalled();
  });

  it('holds for High Risk as well as Very High Risk', async () => {
    // "Below average risk" is both bands beneath Average, not just the
    // bottom one.
    const highRisk = score.scoreReplyWith([{ resultType: 'SU', score: '630' }]); // 624-637
    const deps = scoreDeps(highRisk);

    const result = await gateIdentityOnScore(deps, ID);

    expect(result.kind).toBe('declined');
    expect(deps.startIdentity).not.toHaveBeenCalled();
  });

  it('holds for every hard sentinel, including debt review', async () => {
    for (const xml of [score.SCORE_SENTINEL_DECEASED, score.SCORE_SENTINEL_DEBT_REVIEW]) {
      const deps = scoreDeps(xml);
      const result = await gateIdentityOnScore(deps, ID);
      expect(result.kind).toBe('declined');
      expect(deps.startIdentity).not.toHaveBeenCalled();
    }
  });

  it('spends the score call exactly once — no retry on a substantive answer', async () => {
    const deps = scoreDeps(score.SCORE_SUCCESS_SU_VERY_HIGH);
    await gateIdentityOnScore(deps, ID);
    expect(deps.score).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  REQUIRED TEST 2
//  A failed identity check results in ZERO calls to the affordability
//  client.
// ════════════════════════════════════════════════════════════════════════

describe('REQUIRED: a failed identity check spends nothing on affordability', () => {
  it('makes zero affordability calls', async () => {
    const deps = affordDeps('failed');

    const result = await gateAffordabilityOnIdentity(deps, {
      idNumber: ID, scoreBand: 'low', declared: null,
    });

    expect(result.kind).toBe('identity_not_passed');
    expect(deps.affordability).not.toHaveBeenCalled();
  });

  it('a PENDING identity also spends nothing, and is not a decline', async () => {
    const deps = affordDeps('pending');

    const result = await gateAffordabilityOnIdentity(deps, {
      idNumber: ID, scoreBand: 'low', declared: null,
    });

    expect(deps.affordability).not.toHaveBeenCalled();
    expect(result.kind).toBe('identity_not_passed');
    expect(entersCooldown(result)).toBe(false);
  });

  it('reads identity BEFORE the affordability client, not alongside it', async () => {
    const calls: string[] = [];
    const deps = {
      identityStatus: vi.fn(async () => { calls.push('identity'); return 'passed' as const; }),
      affordability:  vi.fn(async () => { calls.push('affordability'); return parseAffordabilityResponse(afford.AFFORD_SUCCESS_HIGH); }),
    };

    await gateAffordabilityOnIdentity(deps, { idNumber: ID, scoreBand: 'low', declared: null });

    // Sequential, in this order. Running them concurrently would spend the
    // affordability enquiry on an applicant identity might yet reject.
    expect(calls).toEqual(['identity', 'affordability']);
  });

  it('only a passed identity reaches the affordability client', async () => {
    for (const status of ['failed', 'pending'] as const) {
      const deps = affordDeps(status);
      await gateAffordabilityOnIdentity(deps, { idNumber: ID, scoreBand: 'low', declared: null });
      expect(deps.affordability, status).not.toHaveBeenCalled();
    }
    const passed = affordDeps('passed');
    await gateAffordabilityOnIdentity(passed, { idNumber: ID, scoreBand: 'low', declared: null });
    expect(passed.affordability).toHaveBeenCalledTimes(1);
  });
});

// ─── The cooldown gate runs before anything billable ────────────────────

describe('a declined applicant inside cooldown cannot re-trigger enquiries', () => {
  it('spends no score call and no identity call', async () => {
    const until = new Date('2027-01-01T00:00:00Z');
    const deps = scoreDeps(score.SCORE_SUCCESS_SU_SCORED_660, {
      precheck: vi.fn(async () => ({ blocked: true as const, reason: 'cooldown', until })),
    });

    const result = await gateIdentityOnScore(deps, ID);

    expect(result.kind).toBe('blocked');
    expect(result.kind === 'blocked' && result.until).toBe(until);
    expect(deps.score).not.toHaveBeenCalled();
    expect(deps.startIdentity).not.toHaveBeenCalled();
  });

  it('being blocked is not itself a decline — it does not re-enter cooldown', async () => {
    const deps = scoreDeps(score.SCORE_SUCCESS_SU_SCORED_660, {
      precheck: vi.fn(async () => ({ blocked: true as const, reason: 'cooldown' })),
    });
    const result = await gateIdentityOnScore(deps, ID);
    expect(entersCooldown(result)).toBe(false);
  });

  it('an unblocked precheck lets the pipeline proceed normally', async () => {
    const deps = scoreDeps(score.SCORE_SUCCESS_SU_SCORED_660, {
      precheck: vi.fn(async () => ({ blocked: false as const })),
    });
    const result = await gateIdentityOnScore(deps, ID);
    expect(result.kind).toBe('identity_started');
    expect(deps.startIdentity).toHaveBeenCalledTimes(1);
  });
});

// ─── A bureau outage produces pending, never a decline ──────────────────

describe('a bureau outage is pending, not a decline', () => {
  it.each([
    ['a SOAP fault',         score.SCORE_SOAP_FAULT_500],
    ['an HTML error page',   score.SCORE_HTML_ERROR_PAGE],
    ['bad credentials',      score.SCORE_ERROR_107_BAD_CREDENTIALS],
    ['a transient failure',  score.SCORE_ERROR_106_TRANSIENT],
  ])('%s yields pending and spends nothing on identity', async (_label, xml) => {
    const deps = scoreDeps(xml);
    const result = await gateIdentityOnScore(deps, ID);

    expect(result.kind).toBe('pending');
    expect(deps.startIdentity).not.toHaveBeenCalled();
    expect(entersCooldown(result)).toBe(false);
  });

  it('a transport failure yields pending', async () => {
    const deps = scoreDeps('', {
      score: vi.fn(async () => ({ kind: 'unavailable' as const, detail: 'TimeoutError' })),
    });
    const result = await gateIdentityOnScore(deps, ID);
    expect(result.kind).toBe('pending');
    expect(deps.startIdentity).not.toHaveBeenCalled();
  });

  it('an affordability outage yields pending rather than a zero limit', async () => {
    const deps = affordDeps('passed', afford.AFFORD_SOAP_FAULT_500);
    const result = await gateAffordabilityOnIdentity(deps, {
      idNumber: ID, scoreBand: 'low', declared: null,
    });
    expect(result.kind).toBe('pending');
    expect(entersCooldown(result)).toBe(false);
  });
});

// ─── The passing paths ──────────────────────────────────────────────────

describe('a passing score starts identity exactly once', () => {
  it('on a real band', async () => {
    const deps = scoreDeps(score.SCORE_SUCCESS_SU_SCORED_660);
    const result = await gateIdentityOnScore(deps, ID);

    expect(result.kind).toBe('identity_started');
    expect(result.kind === 'identity_started' && result.band).toBe('low');
    expect(deps.startIdentity).toHaveBeenCalledTimes(1);
  });

  it('and on a thin file, which is a grant rather than a refusal', async () => {
    const deps = scoreDeps(score.SCORE_BOTH_UNSCORABLE);
    const result = await gateIdentityOnScore(deps, ID);

    expect(result.kind).toBe('identity_started');
    expect(result.kind === 'identity_started' && result.band).toBe('thin_file');
    expect(deps.startIdentity).toHaveBeenCalledTimes(1);
  });

  it('records the assessment for a decline as well as a pass', async () => {
    // Declines are half the population we need for calibration.
    const recordScore = vi.fn(async () => {});
    const declined = scoreDeps(score.SCORE_SUCCESS_SU_VERY_HIGH, { recordScore });
    await gateIdentityOnScore(declined, ID);
    expect(recordScore).toHaveBeenCalledTimes(1);

    const passed = scoreDeps(score.SCORE_SUCCESS_SU_SCORED_660, { recordScore });
    await gateIdentityOnScore(passed, ID);
    expect(recordScore).toHaveBeenCalledTimes(2);
  });
});

describe('the full assessment prices a limit once identity has passed', () => {
  it('a High-confidence prediction at Low risk caps at the band ceiling', async () => {
    const deps = affordDeps('passed', afford.AFFORD_SUCCESS_HIGH);
    const result = await gateAffordabilityOnIdentity(deps, {
      idNumber: ID, scoreBand: 'low', declared: null,
    });

    expect(result.kind).toBe('assessed');
    if (result.kind !== 'assessed') return;
    expect(result.limit.decision).toBe('approved');
    expect(result.limit.decision === 'approved' && result.limit.limit).toBe(10_000);
    expect(result.limit.binding).toBe('band_ceiling');
  });

  it('Medium confidence takes the haircut', async () => {
    const high   = affordDeps('passed', afford.AFFORD_SUCCESS_MODEST);
    const medium = affordDeps('passed', afford.affordabilityReply({
      ...afford.PAYLOAD_MODEST, GMIP_Confidence_Level: 'Medium',
    }));

    const a = await gateAffordabilityOnIdentity(high,   { idNumber: ID, scoreBand: 'low', declared: null });
    const b = await gateAffordabilityOnIdentity(medium, { idNumber: ID, scoreBand: 'low', declared: null });

    if (a.kind !== 'assessed' || b.kind !== 'assessed') throw new Error('expected assessments');
    expect(a.limit.workings.haircutApplied).toBe(false);
    expect(b.limit.workings.haircutApplied).toBe(true);
    expect(b.limit.workings.monthly!).toBeCloseTo(a.limit.workings.monthly! * 0.85, 6);
  });

  it('a declared figure below the prediction lowers the limit', async () => {
    const deps = affordDeps('passed', afford.AFFORD_SUCCESS_HIGH);
    const result = await gateAffordabilityOnIdentity(deps, {
      idNumber: ID, scoreBand: 'low', declared: declaredGross(8_000),
    });

    if (result.kind !== 'assessed') throw new Error('expected an assessment');
    expect(result.limit.workings.incomeBasis).toBe(8_000);
    expect(result.limit.workings.declaredLoweredBasis).toBe(true);
  });

  it('a declared figure above the prediction changes nothing', async () => {
    const plain = await gateAffordabilityOnIdentity(
      affordDeps('passed'), { idNumber: ID, scoreBand: 'low', declared: null });
    const inflated = await gateAffordabilityOnIdentity(
      affordDeps('passed'), { idNumber: ID, scoreBand: 'low', declared: declaredGross(500_000) });

    if (plain.kind !== 'assessed' || inflated.kind !== 'assessed') throw new Error('expected assessments');
    expect(inflated.limit).toEqual(plain.limit);
  });

  it.each([
    ['-209 no GMIP',     afford.AFFORD_ERROR_209_NO_GMIP],
    ['-217 no record',   afford.AFFORD_ERROR_217_NO_RECORD],
    ['low confidence',   afford.AFFORD_SUCCESS_LOW],
    ['unable to determine', afford.AFFORD_SUCCESS_UNABLE],
  ])('%s downgrades a Low-risk applicant to the thin-file ceiling', async (_label, xml) => {
    const deps = affordDeps('passed', xml);
    const result = await gateAffordabilityOnIdentity(deps, {
      idNumber: ID, scoreBand: 'low', declared: null,
    });

    if (result.kind !== 'assessed') throw new Error('expected an assessment');
    // A good score does not size a limit — an income prediction does.
    expect(result.band).toBe('thin_file');
    expect(result.limit.decision === 'approved' && result.limit.limit).toBe(1_000);
  });

  it('a sub-minimum limit is a decline and enters the cooldown', async () => {
    const deps = affordDeps('passed', afford.affordabilityReply({
      GMIP_Value: '5000', GMIP_Confidence_Level: 'High',
      Bureau_Expenses: '2000', Calc_Living_Expenses: '2000',
      Disposable_Income: '950', Enq_id: 'ENQ-X',
    }));

    const result = await gateAffordabilityOnIdentity(deps, {
      idNumber: ID, scoreBand: 'low', declared: null,
    });

    if (result.kind !== 'assessed') throw new Error('expected an assessment');
    expect(result.limit.decision).toBe('declined');
    expect(entersCooldown(result)).toBe(true);
  });
});

// ─── Cooldown eligibility, across every outcome ─────────────────────────

describe('only substantive refusals enter the cooldown', () => {
  it('a decline does; pending, blocked and not-passed do not', () => {
    expect(entersCooldown({ kind: 'declined' } as never)).toBe(true);
    expect(entersCooldown({ kind: 'pending' } as never)).toBe(false);
    expect(entersCooldown({ kind: 'blocked', reason: 'x' } as never)).toBe(false);
    expect(entersCooldown({ kind: 'identity_not_passed', status: 'failed' } as never)).toBe(false);
    expect(entersCooldown({ kind: 'identity_started' } as never)).toBe(false);
  });
});
