import { describe, it, expect } from 'vitest';
import {
  classifyScore,
  bandDeclines,
  SIGMA_BANDS,
  LEGACY_BANDS,
  COMPUSCORE_BANDS,
  ALL_BANDS,
  SCORE_SENTINELS,
  type BandCutoffs,
} from './bands';

// ─── The reason this table is keyed on the scorecard ────────────────────
//
// One integer, three cards, three different commercial outcomes. If a
// future refactor "simplifies" the band map to a single set of cutoffs,
// this is the test that fails.

describe('the same score means different things on different cards', () => {
  it('620 is Low Risk on Transcend, Average on Standard, Very High on Unsecured Credit', () => {
    expect(classifyScore('STS', '620')).toMatchObject({ kind: 'band', band: 'low' });
    expect(classifyScore('SS',  '620')).toMatchObject({ kind: 'band', band: 'average' });
    expect(classifyScore('SU',  '620')).toMatchObject({ kind: 'band', band: 'very_high' });
  });

  it('and only one of those three declines', () => {
    expect(bandDeclines('low')).toBe(false);
    expect(bandDeclines('average')).toBe(false);
    expect(bandDeclines('very_high')).toBe(true);
  });
});

// ─── Negative sentinels ─────────────────────────────────────────────────

describe('negative scores are sentinels, not low scores', () => {
  it('-1 is a thin file, not a decline', () => {
    expect(classifyScore('SU', '-1')).toMatchObject({ kind: 'thin_file', detail: 'warning_code' });
  });

  it.each([
    [-2, 'deceased'],
    [-3, 'sequestrated'],
    [-4, 'debt_review'],
    [-6, 'fraud'],
  ] as const)('%i declines as %s — never thin-file treatment', (score, detail) => {
    expect(classifyScore('SU', String(score))).toMatchObject({ kind: 'decline', detail });
  });

  it('-4 (debt review) must never be approvable — it is an NCA prohibition', () => {
    const result = classifyScore('SU', '-4');
    expect(result.kind).toBe('decline');
    expect(result.kind).not.toBe('thin_file');
    expect(result.kind).not.toBe('band');
  });

  it('-5 (bureau dispute) is review, not a verdict either way', () => {
    expect(classifyScore('SU', '-5')).toMatchObject({ kind: 'review', detail: 'bureau_dispute' });
  });

  it('no sentinel is ever classified by band comparison', () => {
    // Every sentinel is below every cutoff in every table. If sentinels
    // were compared against cutoffs instead of matched first, all six would
    // come back 'very_high' and decline — including the thin files.
    for (const raw of Object.keys(SCORE_SENTINELS)) {
      const result = classifyScore('SU', raw);
      expect(result.kind).not.toBe('band');
    }
  });

  it('an undefined negative code is unusable, not a decline', () => {
    // We do not refuse an applicant on a code we cannot read.
    expect(classifyScore('SU', '-99')).toMatchObject({ kind: 'unusable' });
  });
});

describe('legacy thin-file range (spec 4.1)', () => {
  it.each([1, 2, 3, 4])('a score of %i is a thin file', (score) => {
    expect(classifyScore('CPA', String(score))).toMatchObject({
      kind: 'thin_file', detail: 'legacy_range',
    });
  });

  it('5 is not a thin file but is out of plausible range', () => {
    expect(classifyScore('CPA', '5')).toMatchObject({ kind: 'unusable', detail: 'out_of_range' });
  });
});

// ─── Refusing to guess ──────────────────────────────────────────────────

describe('unknown inputs resolve to unusable, never to a band', () => {
  it('an unrecognised scorecard does not fall through to a default table', () => {
    expect(classifyScore('ZZZ', '620')).toMatchObject({
      kind: 'unusable', detail: 'unknown_scorecard',
    });
  });

  it('a non-numeric score is unusable rather than NaN-compared', () => {
    expect(classifyScore('SU', 'not-a-number')).toMatchObject({ kind: 'unusable' });
  });

  it('a card outside the selected family is rejected when a narrow table is passed', () => {
    // pVersion selects the family; a CPA result arriving on a Sigma call is
    // a signal something is misconfigured, not something to band anyway.
    expect(classifyScore('CPA', '650', SIGMA_BANDS)).toMatchObject({
      kind: 'unusable', detail: 'unknown_scorecard',
    });
  });

  it('an implausible score is unusable', () => {
    expect(classifyScore('SU', '99999')).toMatchObject({ kind: 'unusable', detail: 'out_of_range' });
    expect(classifyScore('SU', '0')).toMatchObject({ kind: 'unusable' });
  });
});

// ─── Every published cutoff, exactly ────────────────────────────────────

describe('band boundaries are inclusive at the published lower bound', () => {
  const tables: Array<[string, Readonly<Record<string, BandCutoffs>>]> = [
    ['sigma', SIGMA_BANDS],
    ['legacy', LEGACY_BANDS],
    ['compuscore', COMPUSCORE_BANDS],
  ];

  for (const [family, table] of tables) {
    for (const [card, cut] of Object.entries(table)) {
      it(`${family}/${card}: each boundary lands in the band it opens`, () => {
        expect(classifyScore(card, cut.high    - 1, table)).toMatchObject({ band: 'very_high' });
        expect(classifyScore(card, cut.high,        table)).toMatchObject({ band: 'high' });
        expect(classifyScore(card, cut.average - 1, table)).toMatchObject({ band: 'high' });
        expect(classifyScore(card, cut.average,     table)).toMatchObject({ band: 'average' });
        expect(classifyScore(card, cut.low     - 1, table)).toMatchObject({ band: 'average' });
        expect(classifyScore(card, cut.low,         table)).toMatchObject({ band: 'low' });
        expect(classifyScore(card, cut.minimum - 1, table)).toMatchObject({ band: 'low' });
        expect(classifyScore(card, cut.minimum,     table)).toMatchObject({ band: 'minimum' });
      });
    }
  }

  it('every table is strictly ascending — no gaps, no overlaps', () => {
    for (const [card, cut] of Object.entries(ALL_BANDS)) {
      expect(cut.high,    `${card}.high < average`).toBeLessThan(cut.average);
      expect(cut.average, `${card}.average < low`).toBeLessThan(cut.low);
      expect(cut.low,     `${card}.low < minimum`).toBeLessThan(cut.minimum);
    }
  });
});

// ─── Pinning the live sample ────────────────────────────────────────────

describe('the captured UAT response', () => {
  it('classifies SU=-1 as thin file and STS=620 as low risk', () => {
    expect(classifyScore('SU',  '-1',  SIGMA_BANDS)).toMatchObject({ kind: 'thin_file' });
    expect(classifyScore('STS', '620', SIGMA_BANDS)).toMatchObject({ kind: 'band', band: 'low' });
  });
});
