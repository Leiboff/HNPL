/**
 * Decisioning tests. No network, no credentials, nothing billable.
 *
 * Written against node:test so it runs with zero dependencies:
 *   npx tsx --test experian.test.ts
 * For vitest, swap the import for `import { describe, it } from 'vitest'` and
 * `expect` for `assert` — the assertions map one to one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseReturnData, type ExperianOutcome } from './client';
import { bandFor, gate, warningFor, isRealScore, selectScorecard, CREDIT_ACTIVE_FLOOR } from './scores';
import { decide, RISK_EXPOSURE_CENTS, SCORECARD_PREFERENCE } from './assess-at-signup';
import { FIXTURES, ERROR_CODES } from './fixtures';

const asOk = (json: string): ExperianOutcome => ({
  kind: 'ok',
  latencyMs: 1,
  raw: json,
  ...parseReturnData(json),
});

describe('real captured payloads', () => {
  test('NLR 650 / CPA 664 both band 4', () => {
    const { results } = parseReturnData(FIXTURES.real_nlr_cpa_credit_active);
    assert.equal(results.length, 2);
    assert.equal(bandFor('NLR', 650), 4);
    assert.equal(bandFor('CPA', 664), 4);
    assert.ok(results.every(isRealScore));
    assert.equal(gate(results).decision, 'proceed');
  });

  test('SS 684 is band 5 and reason codes survive parsing', () => {
    const { results } = parseReturnData(FIXTURES.real_ss_minimum_risk);
    assert.equal(bandFor('SS', 684), 5);
    assert.deepEqual(results[0].reasons.map((r) => r.code), ['TM61', 'TM44']);
  });

  test('score arrives as a string and is coerced, not trusted', () => {
    const { results } = parseReturnData(FIXTURES.real_ss_minimum_risk);
    assert.equal(results[0].rawScore, '684');
    assert.equal(results[0].score, 684);
    assert.equal(typeof results[0].score, 'number');
  });
});

describe('band boundaries', () => {
  // Every boundary from §4.1, §4.2 and §5.3, both sides.
  const cases: Array<[string, number, number]> = [
    ['SS', 598, 1], ['SS', 599, 2], ['SS', 615, 2], ['SS', 616, 3],
    ['SS', 633, 3], ['SS', 634, 4], ['SS', 657, 4], ['SS', 658, 5],
    ['SU', 623, 1], ['SU', 624, 2], ['SU', 667, 4], ['SU', 668, 5],
    ['SBF', 617, 1], ['SBF', 618, 2], ['SBF', 682, 4], ['SBF', 683, 5],
    ['SRC', 583, 1], ['SRC', 584, 2], ['SRC', 624, 4], ['SRC', 625, 5],
    ['SCM', 628, 1], ['SCM', 629, 2], ['SCM', 697, 4], ['SCM', 698, 5],
    ['STS', 597, 1], ['STS', 598, 2], ['STS', 621, 4], ['STS', 622, 5],
    ['CT', 594, 1], ['CT', 595, 2], ['CT', 659, 4], ['CT', 660, 5],
    ['CU', 621, 1], ['CU', 622, 2], ['CU', 672, 4], ['CU', 673, 5],
    ['CPA', 605, 1], ['CPA', 606, 2], ['CPA', 667, 4], ['CPA', 668, 5],
    ['NLR', 603, 1], ['NLR', 604, 2], ['NLR', 653, 4], ['NLR', 654, 5],
  ];
  for (const [card, score, band] of cases) {
    test(`${card} ${score} -> band ${band}`, () => assert.equal(bandFor(card, score), band));
  }

  test('no gaps or overlaps across the full credit-active range', () => {
    for (const card of ['SS', 'SU', 'SBF', 'SRC', 'SCM', 'STS']) {
      for (let s = CREDIT_ACTIVE_FLOOR; s <= 750; s++) {
        assert.ok(bandFor(card, s) !== null, `${card} ${s} has no band`);
      }
    }
  });
});

describe('the two "no score" conventions', () => {
  const identityFlags: Array<[keyof typeof FIXTURES, string]> = [
    ['ss_deceased', 'WARN-2'],
    ['ss_sequestrated', 'WARN-3'],
    ['ss_debt_review', 'WARN-4'],
    ['ss_fraud', 'WARN-6'],
  ];
  for (const [fixture, code] of identityFlags) {
    test(`${fixture} hard declines with ${code}`, () => {
      const d = decide(asOk(FIXTURES[fixture]));
      assert.equal(d.decision, 'declined');
      assert.deepEqual(d.reasonCodes, [code]);
      assert.equal(d.riskExposureCents, null);
    });
  }

  test('bureau dispute refers rather than declines', () => {
    assert.equal(decide(asOk(FIXTURES.ss_bureau_dispute)).decision, 'referred');
  });

  test('an unrecognised negative code refers, never scores', () => {
    const { results } = parseReturnData(FIXTURES.ss_unknown_warning);
    assert.equal(warningFor(results[0])?.action, 'manual_review');
    assert.equal(isRealScore(results[0]), false);
  });

  test('legacy 1-4 is a thin file, NOT a very-low score', () => {
    const { results } = parseReturnData(FIXTURES.legacy_thin_file);
    assert.ok(results.every((r) => !isRealScore(r)));
    assert.equal(bandFor('NLR', 3), null, 'a thin file must have no band');
    assert.equal(gate(results).decision, 'thin_file');
  });

  test('479 is below the credit-active floor, 480 is not', () => {
    const { results } = parseReturnData(FIXTURES.legacy_thin_floor);
    assert.equal(isRealScore(results[0]), false);
    assert.equal(bandFor('NLR', 480), 1);
  });

  test('Sigma is exempt from the legacy floor', () => {
    // A Sigma card would never send 1-4; only negatives mean "no score" there.
    assert.equal(bandFor('SS', 490), 1);
  });
});

describe('real thin file (captured Aug 2026)', () => {
  test('-1 is a warning, not a score, and carries no band', () => {
    const { results } = parseReturnData(FIXTURES.real_su_thin_file);
    assert.equal(results[0].score, -1);
    assert.equal(isRealScore(results[0]), false);
    assert.equal(warningFor(results[0])?.action, 'thin_file');
    assert.equal(bandFor('SU', -1), null);
  });

  test('reason codes accompany a warning value', () => {
    const { results } = parseReturnData(FIXTURES.real_su_thin_file);
    assert.deepEqual(results[0].reasons.map((r) => r.code), ['MI62']);
  });

  test('routes to referred and keeps both the warning and the diagnostic code', () => {
    const d = decide(asOk(FIXTURES.real_su_thin_file));
    assert.equal(d.decision, 'referred');
    assert.ok(d.reasonCodes.includes('WARN-1'), 'thin-file signal must survive');
    assert.ok(d.reasonCodes.includes('MI62'), 'diagnostic reason must survive');
    assert.notEqual(d.detail, 'no usable scorecard');
    assert.equal(d.riskExposureCents, null);
  });

  test('real credit-active SU file bands correctly', () => {
    const { results } = parseReturnData(FIXTURES.real_su_credit_active);
    assert.equal(bandFor('SU', results[0].score!), 4);
    assert.equal(decide(asOk(FIXTURES.real_su_credit_active)).scorecard, 'SU');
  });
});

describe('multi-scorecard handling', () => {
  test('one identity flag decides the whole application', () => {
    assert.equal(decide(asOk(FIXTURES.mixed_deceased_and_good)).decision, 'declined');
  });

  test('one thin card alongside a scored card is not a thin file', () => {
    const d = decide(asOk(FIXTURES.mixed_one_card_thin));
    assert.notEqual(d.decision, 'declined');
    assert.equal(d.scorecard, 'SS');
  });

  test('preference order is honoured, not array order', () => {
    const json = '{"results":[{"resultType":"SS","score":"684","reasons":[]},{"resultType":"SU","score":"640","reasons":[]}]}';
    assert.equal(decide(asOk(json)).scorecard, 'SU');
    assert.equal(SCORECARD_PREFERENCE[0], 'SU');
  });

  test('a scorecard outside the preference list refers rather than guessing', () => {
    assert.equal(decide(asOk(FIXTURES.unknown_scorecard)).decision, 'referred');
  });

  test('empty results refers', () => {
    assert.equal(decide(asOk(FIXTURES.no_results)).decision, 'referred');
  });
});

describe('parser tolerance', () => {
  test('singular "result" key', () => {
    assert.equal(parseReturnData(FIXTURES.singular_result_key).results.length, 1);
  });

  test('missing idNumber is null, not a crash', () => {
    assert.equal(parseReturnData(FIXTURES.no_id_echoed).idNumber, null);
  });

  test('XML metacharacters survive round-trip intact', () => {
    const { results } = parseReturnData(FIXTURES.reason_with_metachars);
    assert.equal(results[0].reasons[0].description, 'Unsecured Credit & Short Term <loans> indicate "high" risk');
  });
});

describe('error codes', () => {
  test('every documented code maps to a non-approving decision', () => {
    for (const [code, desc] of ERROR_CODES) {
      const kind = code === '-115' ? 'thin_file'
        : ['-113', '-114'].includes(code) ? 'input_error'
        : ['-106', '-999'].includes(code) ? 'provider_error'
        : 'config_error';
      const d = decide({ kind, errorCode: code, errorDescription: desc, latencyMs: 1 } as ExperianOutcome);
      assert.notEqual(d.decision, 'approved', `${code} must never approve`);
      assert.equal(d.riskExposureCents, null);
    }
  });

  test('a transport failure never approves and never invents an exposure', () => {
    const d = decide({ kind: 'transport_error', reason: 'timeout', httpStatus: null, latencyMs: 1 });
    assert.equal(d.decision, 'error');
    assert.equal(d.billed, false);
  });
});

describe('fail-closed policy', () => {
  test('uncalibrated bands refer, they do not approve', () => {
    const d = decide(asOk(FIXTURES.real_ss_minimum_risk));
    assert.equal(d.decision, 'referred');
    assert.match(d.detail, /no exposure configured/);
  });

  test('band 1 declines outright', () => {
    assert.equal(decide(asOk(FIXTURES.ss_band1_upper)).decision, 'declined');
  });

  test('approves only once a cell is calibrated', () => {
    const before = RISK_EXPOSURE_CENTS.SS[5];
    RISK_EXPOSURE_CENTS.SS[5] = 500_000;
    try {
      const d = decide(asOk(FIXTURES.real_ss_minimum_risk));
      assert.equal(d.decision, 'approved');
      assert.equal(d.riskExposureCents, 500_000);
      assert.deepEqual(d.reasonCodes, ['TM61', 'TM44']);
    } finally {
      RISK_EXPOSURE_CENTS.SS[5] = before;
    }
  });

  test('exposure tables are per scorecard, so calibration cannot leak across cards', () => {
    const before = RISK_EXPOSURE_CENTS.SS[4];
    RISK_EXPOSURE_CENTS.SS[4] = 250_000;
    try {
      // SS band 4 is now funded; an NLR band 4 must still refer.
      const nlr = '{"results":[{"resultType":"NLR","score":"650","reasons":[]}]}';
      assert.equal(decide(asOk(nlr)).decision, 'referred');
    } finally {
      RISK_EXPOSURE_CENTS.SS[4] = before;
    }
  });
});
