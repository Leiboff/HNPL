import { describe, it, expect } from 'vitest';
import { parseReturnData } from './client';
import {
  bandFor,
  gate,
  warningFor,
  isRealScore,
  isSigmaScorecard,
  isKnownScorecard,
  CREDIT_ACTIVE_FLOOR,
  type RiskBand,
} from './scores';
import { FIXTURES } from '@/lib/testing/experianFixtures';

// ─── Band tables and the two "no score" conventions ────────────────────
//
// Converted from docs/experian/experian.test.ts, which was written against
// node:test. The assertions map one to one — assert.equal → expect().toBe,
// assert.deepEqual → expect().toEqual, assert.ok → expect().toBe(true).
//
// What these protect is a decision, not a number. A negative value from
// Experian is a WARNING CODE, not a low score: -2 is deceased. Any comparison
// of a raw value against a threshold turns "deceased" into "declined for
// risk", which is the wrong decision AND the wrong adverse-action reason on
// the POPIA §71 record.

const ALL_SCORECARDS = ['SS', 'SU', 'SBF', 'SRC', 'SCM', 'STS', 'CT', 'CU', 'CPA', 'NLR'] as const;

describe('real captured payloads', () => {
  it('NLR 650 / CPA 664 both band 4', () => {
    const { results } = parseReturnData(FIXTURES.real_nlr_cpa_credit_active);
    expect(results.length).toBe(2);
    expect(bandFor('NLR', 650)).toBe(4);
    expect(bandFor('CPA', 664)).toBe(4);
    expect(results.every(isRealScore)).toBe(true);
    expect(gate(results).decision).toBe('proceed');
  });

  it('SS 684 is band 5 and reason codes survive parsing', () => {
    const { results } = parseReturnData(FIXTURES.real_ss_minimum_risk);
    expect(bandFor('SS', 684)).toBe(5);
    expect(results[0].reasons.map((r) => r.code)).toEqual(['TM61', 'TM44']);
  });

  it('score arrives as a string and is coerced, not trusted', () => {
    const { results } = parseReturnData(FIXTURES.real_ss_minimum_risk);
    expect(results[0].rawScore).toBe('684');
    expect(results[0].score).toBe(684);
    expect(typeof results[0].score).toBe('number');
  });
});

describe('band boundaries', () => {
  // Every boundary from §4.1, §4.2 and §5.3, both sides.
  const cases: Array<[string, number, RiskBand]> = [
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
  it.each(cases)('%s %i -> band %i', (card, score, band) => {
    expect(bandFor(card, score)).toBe(band);
  });

  // ── NAMED TEST (17) ──────────────────────────────────────────────────
  it('band boundaries have no gaps or overlaps, 480–750, on every scorecard', () => {
    // The reference swept the Sigma cards. This sweeps ALL TEN, legacy
    // included, because 480 is exactly where the legacy thin-file convention
    // stops and a real score starts — the boundary most likely to be got
    // wrong is the one the two families share.
    //
    // "No overlaps" is checked as monotonicity rather than as set
    // intersection: bandFor returns ONE band per score, so an overlap cannot
    // show up as two answers. It shows up as a band that goes DOWN as the
    // score goes up, which is what an inverted or mistyped bound produces.
    for (const card of ALL_SCORECARDS) {
      let previous = 0;
      for (let s = CREDIT_ACTIVE_FLOOR; s <= 750; s++) {
        const band = bandFor(card, s);
        expect(band, `${card} ${s} has no band`).not.toBeNull();
        expect(band, `${card} ${s}: band went backwards from ${previous}`)
          .toBeGreaterThanOrEqual(previous);
        previous = band!;
      }
      // And the sweep actually crossed the whole range, so a table that
      // returned band 1 throughout could not pass the monotonic check alone.
      expect(bandFor(card, CREDIT_ACTIVE_FLOOR), `${card} floor`).toBe(1);
      expect(bandFor(card, 750), `${card} ceiling`).toBe(5);
    }
  });

  it('every scorecard in the preference list has a band table', () => {
    for (const card of ['SU', 'SS', 'STS']) {
      expect(isKnownScorecard(card), card).toBe(true);
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
  it.each(identityFlags)('%s hard declines with %s', (fixture, code) => {
    const { results } = parseReturnData(FIXTURES[fixture]);
    const g = gate(results);
    expect(g.decision).toBe('hard_decline');
    expect(g.codes).toEqual([code]);
  });

  it('bureau dispute refers rather than declines', () => {
    expect(gate(parseReturnData(FIXTURES.ss_bureau_dispute).results).decision)
      .toBe('manual_review');
  });

  it('an unrecognised negative code refers, never scores', () => {
    const { results } = parseReturnData(FIXTURES.ss_unknown_warning);
    expect(warningFor(results[0])?.action).toBe('manual_review');
    expect(isRealScore(results[0])).toBe(false);
  });

  // ── NAMED TEST (4), first half ───────────────────────────────────────
  it('a legacy score of 3 is a thin file, NOT a very-low score', () => {
    const { results } = parseReturnData(FIXTURES.legacy_thin_file);
    expect(results.every((r) => !isRealScore(r))).toBe(true);
    expect(bandFor('NLR', 3), 'a thin file must have no band').toBeNull();
    expect(gate(results).decision).toBe('thin_file');
  });

  it('479 is below the credit-active floor, 480 is not', () => {
    const { results } = parseReturnData(FIXTURES.legacy_thin_floor);
    expect(isRealScore(results[0])).toBe(false);
    expect(bandFor('NLR', 480)).toBe(1);
  });

  it('Sigma is exempt from the legacy floor', () => {
    // A Sigma card would never send 1-4; only negatives mean "no score" there.
    expect(bandFor('SS', 490)).toBe(1);
    expect(isSigmaScorecard('SS')).toBe(true);
    expect(isSigmaScorecard('NLR')).toBe(false);
  });

  it('STS is a Sigma card, so the legacy floor does not apply to it either', () => {
    // Load-bearing for the 4.0 fallback: STS is the thin-file scorecard, and
    // treating it as legacy would make a low Transcend score read as "no data".
    expect(isSigmaScorecard('STS')).toBe(true);
    expect(bandFor('STS', 490)).toBe(1);
  });
});

describe('real thin file (captured Aug 2026)', () => {
  it('-1 is a warning, not a score, and carries no band', () => {
    const { results } = parseReturnData(FIXTURES.real_su_thin_file);
    expect(results[0].score).toBe(-1);
    expect(isRealScore(results[0])).toBe(false);
    expect(warningFor(results[0])?.action).toBe('thin_file');
    expect(bandFor('SU', -1)).toBeNull();
  });

  it('reason codes accompany a warning value', () => {
    const { results } = parseReturnData(FIXTURES.real_su_thin_file);
    expect(results[0].reasons.map((r) => r.code)).toEqual(['MI62']);
  });

  it('real credit-active SU file bands correctly', () => {
    const { results } = parseReturnData(FIXTURES.real_su_credit_active);
    expect(bandFor('SU', results[0].score!)).toBe(4);
  });
});

describe('the gate across multiple scorecards', () => {
  it('one identity flag decides the whole application', () => {
    const { results } = parseReturnData(FIXTURES.mixed_deceased_and_good);
    expect(gate(results).decision).toBe('hard_decline');
  });

  it('one thin card alongside a scored card is not a thin file', () => {
    // §8 returns SCM -1 next to a scored SU: customer-management has nothing
    // to score on a non-customer. Thin file only counts when EVERY card is thin.
    const { results } = parseReturnData(FIXTURES.mixed_one_card_thin);
    expect(gate(results).decision).toBe('proceed');
  });

  it('empty results is a manual review, never a proceed', () => {
    const { results } = parseReturnData(FIXTURES.no_results);
    const g = gate(results);
    expect(g.decision).toBe('manual_review');
    expect(g.codes).toEqual(['NO_RESULTS']);
  });
});
