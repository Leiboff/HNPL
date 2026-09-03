import { describe, it, expect } from 'vitest';
import { decideScoreGate, scoreGatePasses, bandFromDecision } from './scoreGate';
import { parseGetScoreResponse } from '@/lib/experian/scoreClient';
import { SIGMA_BANDS } from '@/lib/experian/bands';
import { DEFAULT_SCORECARD_PREFERENCE } from '@/lib/experian/config';
import * as fx from '@/lib/experian/__fixtures__/score';

const PREF = [...DEFAULT_SCORECARD_PREFERENCE]; // SU, then STS

function gate(xml: string, preference: readonly string[] = PREF) {
  return decideScoreGate(parseGetScoreResponse(xml), preference, SIGMA_BANDS);
}

// ─── The Transcend fallback ─────────────────────────────────────────────

describe('the captured applicant: SU unscorable, STS 620', () => {
  const decision = gate(fx.SCORE_SUCCESS_SU_UNSCORABLE_STS_620);

  it('falls back to Transcend and passes at Low Risk', () => {
    expect(decision.kind).toBe('pass');
    expect(decision.kind === 'pass' && decision.band).toBe('low');
    expect(decision.kind === 'pass' && decision.resultType).toBe('STS');
    expect(decision.kind === 'pass' && decision.score).toBe(620);
  });

  it('records every card returned, not just the deciding one', () => {
    // The assessment log needs both: if a cohort goes bad we need to see
    // that the primary card could not score them.
    expect(decision.results.map((r) => r.resultType)).toEqual(['SU', 'STS']);
  });

  it('would be a thin file if the fallback were disabled', () => {
    // Reading SU alone prices this applicant at R1,000 instead of R10,000.
    // The 10x sits entirely in the preference list, which is why it is
    // config rather than a constant.
    const suOnly = gate(fx.SCORE_SUCCESS_SU_UNSCORABLE_STS_620, ['SU']);
    expect(suOnly.kind).toBe('thin_file');
  });
});

describe('the primary card is preferred when it can score', () => {
  it('uses SU and ignores a differing STS score', () => {
    // SU 660 is Low Risk (652-667); STS 615 would be Low Risk too but on a
    // different table. The preferred card decides.
    const decision = gate(fx.SCORE_SUCCESS_SU_SCORED_660);
    expect(decision.kind === 'pass' && decision.resultType).toBe('SU');
    expect(decision.kind === 'pass' && decision.band).toBe('low');
  });
});

// ─── Declines ───────────────────────────────────────────────────────────

describe('band declines', () => {
  it('Very High Risk on the primary card declines', () => {
    const decision = gate(fx.SCORE_SUCCESS_SU_VERY_HIGH);
    expect(decision.kind).toBe('decline');
    expect(decision.kind === 'decline' && decision.reason).toBe('band');
    expect(decision.kind === 'decline' && decision.band).toBe('very_high');
  });

  it('a band decline does not fall through to another card', () => {
    // Falling back on a DECLINE rather than on an unscorable card would let
    // an applicant refused by the unsecured model be approved by the
    // thin-file one. Only an unscorable card falls back.
    const decision = gate(fx.scoreReplyWith([
      { resultType: 'SU', score: '600' },   // Very High on SU
      { resultType: 'STS', score: '700' },  // Minimum on STS
    ]));
    expect(decision.kind).toBe('decline');
  });
});

describe('hard sentinels decline immediately and ignore any fallback score', () => {
  it('deceased declines even though Transcend scored 640', () => {
    const decision = gate(fx.SCORE_SENTINEL_DECEASED);
    expect(decision.kind).toBe('decline');
    expect(decision.kind === 'decline' && decision.reason).toBe('deceased');
  });

  it('debt review declines even though Transcend scored 700', () => {
    // An NCA prohibition. There is no score that overrides it.
    const decision = gate(fx.SCORE_SENTINEL_DEBT_REVIEW);
    expect(decision.kind).toBe('decline');
    expect(decision.kind === 'decline' && decision.reason).toBe('debt_review');
  });

  it('never treats a sentinel as thin file', () => {
    for (const xml of [fx.SCORE_SENTINEL_DECEASED, fx.SCORE_SENTINEL_DEBT_REVIEW]) {
      expect(gate(xml).kind).not.toBe('thin_file');
      expect(gate(xml).kind).not.toBe('pass');
    }
  });
});

// ─── Thin file ──────────────────────────────────────────────────────────

describe('thin file', () => {
  it('both cards unscorable is a thin file, not a decline', () => {
    const decision = gate(fx.SCORE_BOTH_UNSCORABLE);
    expect(decision.kind).toBe('thin_file');
    expect(decision.kind === 'thin_file' && decision.detail).toBe('warning_code');
  });

  it('-115 (no bureau record) is a thin file', () => {
    const decision = gate(fx.SCORE_ERROR_115_THIN_FILE);
    expect(decision.kind).toBe('thin_file');
    expect(decision.kind === 'thin_file' && decision.detail).toBe('no_bureau_record');
  });

  it('a thin file still passes the gate — it caps the limit, it does not refuse', () => {
    expect(scoreGatePasses(gate(fx.SCORE_BOTH_UNSCORABLE))).toBe(true);
    expect(bandFromDecision(gate(fx.SCORE_BOTH_UNSCORABLE))).toBe('thin_file');
  });
});

// ─── Pending: the outcome that must never look like a refusal ───────────

describe('technical failure resolves to pending, never to a decline', () => {
  it.each([
    ['a SOAP fault',        fx.SCORE_SOAP_FAULT_500],
    ['an HTML error page',  fx.SCORE_HTML_ERROR_PAGE],
    ['bad credentials',     fx.SCORE_ERROR_107_BAD_CREDENTIALS],
    ['an unbound envelope', fx.SCORE_ERROR_101_NOT_BOUND],
    ['branch switched off', fx.SCORE_ERROR_110_BRANCH_OFF],
    ['a transient failure', fx.SCORE_ERROR_106_TRANSIENT],
    ['an unknown error',    fx.SCORE_ERROR_999_UNKNOWN],
    ['an undocumented code', fx.SCORE_ERROR_UNDOCUMENTED],
  ])('%s is pending', (_label, xml) => {
    const decision = gate(xml);
    expect(decision.kind).toBe('pending');
    expect(decision.kind).not.toBe('decline');
  });

  it('a transport failure is pending', () => {
    const decision = decideScoreGate(
      { kind: 'unavailable', detail: 'TimeoutError: signal timed out' }, PREF, SIGMA_BANDS);
    expect(decision.kind).toBe('pending');
    expect(decision.kind === 'pending' && decision.alert).toBe(false);
  });

  it('our own misconfiguration alerts; a transient bureau blip does not', () => {
    expect(gate(fx.SCORE_ERROR_107_BAD_CREDENTIALS)).toMatchObject({ alert: true });
    expect(gate(fx.SCORE_ERROR_101_NOT_BOUND)).toMatchObject({ alert: true });
    expect(gate(fx.SCORE_ERROR_106_TRANSIENT)).toMatchObject({ alert: false });
  });

  it('a bureau dispute is flagged for review rather than retried', () => {
    const decision = gate(fx.SCORE_SENTINEL_DISPUTE);
    expect(decision.kind).toBe('pending');
    expect(decision.kind === 'pending' && decision.review).toBe(true);
  });

  it('cards outside the preference list alert instead of being banded', () => {
    // Banding against a card we did not ask for would price the applicant
    // on the wrong model. A config mismatch should be heard, not absorbed.
    const decision = gate(fx.SCORE_UNEXPECTED_CARDS_ONLY);
    expect(decision.kind).toBe('pending');
    expect(decision.kind === 'pending' && decision.alert).toBe(true);
    expect(decision.kind === 'pending' && decision.detail).toContain('SBF');
  });

  it('a pending decision never yields a band for the limit calculation', () => {
    expect(bandFromDecision(gate(fx.SCORE_SOAP_FAULT_500))).toBeNull();
    expect(scoreGatePasses(gate(fx.SCORE_SOAP_FAULT_500))).toBe(false);
  });
});

// ─── The invariant that must survive refactors ──────────────────────────

describe('no reply of any kind produces a decline unless it is substantive', () => {
  it('only band declines and hard sentinels decline', () => {
    const substantive = [
      fx.SCORE_SUCCESS_SU_VERY_HIGH,
      fx.SCORE_SENTINEL_DECEASED,
      fx.SCORE_SENTINEL_DEBT_REVIEW,
    ];
    const everythingElse = [
      fx.SCORE_SUCCESS_SU_UNSCORABLE_STS_620,
      fx.SCORE_SUCCESS_SU_SCORED_660,
      fx.SCORE_BOTH_UNSCORABLE,
      fx.SCORE_UNEXPECTED_CARDS_ONLY,
      fx.SCORE_SENTINEL_DISPUTE,
      fx.SCORE_ERROR_115_THIN_FILE,
      fx.SCORE_ERROR_107_BAD_CREDENTIALS,
      fx.SCORE_ERROR_101_NOT_BOUND,
      fx.SCORE_ERROR_110_BRANCH_OFF,
      fx.SCORE_ERROR_114_INVALID_ID,
      fx.SCORE_ERROR_106_TRANSIENT,
      fx.SCORE_ERROR_999_UNKNOWN,
      fx.SCORE_ERROR_UNDOCUMENTED,
      fx.SCORE_SOAP_FAULT_500,
      fx.SCORE_HTML_ERROR_PAGE,
    ];

    for (const xml of substantive)    expect(gate(xml).kind).toBe('decline');
    for (const xml of everythingElse) expect(gate(xml).kind).not.toBe('decline');
  });
});
