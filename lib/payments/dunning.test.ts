import { describe, it, expect } from 'vitest';
import {
  advanceLadderAfterFailure,
  chargeAmountCents,
  computeFeeCapCents,
  addDaysISO,
  DUNNING_FEE_CENTS,
  DUNNING_FEE_CAP_ABSOLUTE_CENTS,
  INTRA_PAIR_GAP_DAYS,
  INTER_PAIR_GAP_DAYS,
} from './dunning';

// ─── Pure math — ladder progression (the "two-fails-per-fee" rule) ──────────
//
// These tests pin the brief's exact ladder behaviour:
//
//   Attempt 1 (Day 0) fails → counter=1, no fee
//   Attempt 2 (Day 1) fails → counter=0, +R100 fee   (end of pair)
//   Attempt 3 (Day 7) fails → counter=1, no fee
//   Attempt 4 (Day 8) fails → counter=0, +R100 fee   (end of pair)
//   Attempt 5 (Day 14) fails → counter=1, no fee
//   Attempt 6 (Day 15) fails → counter=0, +R100 fee  → cap reached → defaulted

describe('computeFeeCapCents — cap = min(R300, 50% of bill)', () => {
  it('large bill (>R600) is bounded by the absolute cap (R300)', () => {
    expect(computeFeeCapCents(1000)).toBe(30_000);
    expect(computeFeeCapCents(600)).toBe(30_000);
  });

  it('small bill is bounded by the 50% cap', () => {
    expect(computeFeeCapCents(400)).toBe(20_000); // R200
    expect(computeFeeCapCents(150)).toBe(7_500);  // R75
  });

  it('floors to whole cents (no sub-cent quotes)', () => {
    expect(computeFeeCapCents(100.99)).toBe(5_049);
  });
});

describe('addDaysISO', () => {
  it('adds days through DST boundaries without offset drift', () => {
    expect(addDaysISO('2026-03-01', 1)).toBe('2026-03-02');
    expect(addDaysISO('2026-03-01', 7)).toBe('2026-03-08');
    expect(addDaysISO('2026-03-01', 6)).toBe('2026-03-07');
  });
});

describe('chargeAmountCents — retry-carries-fees', () => {
  it('returns instalment-only cents when no fees accrued', () => {
    expect(chargeAmountCents(250.75, 0)).toBe(25_075);
  });

  it('adds accrued fees on top of the instalment', () => {
    expect(chargeAmountCents(250, 10_000)).toBe(35_000);
    expect(chargeAmountCents(250, 30_000)).toBe(55_000);
  });
});

// ─── Ladder progression on a typical R1000 bill (large bill, R300 cap) ──────

describe('advanceLadderAfterFailure — happy path on a R1000 bill', () => {
  const bill = 1000;
  const day0 = '2026-06-15';

  it('Day 0 fail — first of pair, no fee, schedules Day 1', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 0,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           day0,
    });
    expect(r.feeAppliedThisAttempt).toBe(0);
    expect(r.consecutiveFailedAttemptsAfter).toBe(1);
    expect(r.dunningFeesCentsAfter).toBe(0);
    expect(r.capReached).toBe(false);
    expect(r.terminalStatus).toBeNull();
    expect(r.nextAttemptDate).toBe(addDaysISO(day0, INTRA_PAIR_GAP_DAYS));
  });

  it('Day 1 fail — second of pair, +R100 fee, counter resets, schedules Day 7', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           addDaysISO(day0, 1),
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS);
    expect(r.consecutiveFailedAttemptsAfter).toBe(0);
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CENTS);
    expect(r.capReached).toBe(false);
    expect(r.nextAttemptDate).toBe(addDaysISO(addDaysISO(day0, 1), INTER_PAIR_GAP_DAYS));
  });

  it('Day 7 fail — first of next pair, no fee, schedules Day 8', () => {
    const day7 = addDaysISO(addDaysISO(day0, 1), INTER_PAIR_GAP_DAYS);
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 0,
      dunningFeesCentsBefore:          DUNNING_FEE_CENTS,
      originalBillRands:               bill,
      today:                           day7,
    });
    expect(r.feeAppliedThisAttempt).toBe(0);
    expect(r.consecutiveFailedAttemptsAfter).toBe(1);
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CENTS);
    expect(r.nextAttemptDate).toBe(addDaysISO(day7, INTRA_PAIR_GAP_DAYS));
  });

  it('Day 8 fail — second of pair, +R100 fee (#2), counter resets, schedules Day 14', () => {
    const day8 = addDaysISO(addDaysISO(addDaysISO(day0, 1), INTER_PAIR_GAP_DAYS), 1);
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,
      dunningFeesCentsBefore:          DUNNING_FEE_CENTS,
      originalBillRands:               bill,
      today:                           day8,
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS);
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CENTS * 2);
    expect(r.capReached).toBe(false);
    expect(r.nextAttemptDate).toBe(addDaysISO(day8, INTER_PAIR_GAP_DAYS));
  });

  it('Day 15 fail — fee #3 lands → cap reached → terminal defaulted', () => {
    // day8 + 6 = day14; day14 + 1 = day15
    const day8  = addDaysISO(addDaysISO(addDaysISO(day0, 1), INTER_PAIR_GAP_DAYS), 1);
    const day14 = addDaysISO(day8, INTER_PAIR_GAP_DAYS);
    const day15 = addDaysISO(day14, INTRA_PAIR_GAP_DAYS);
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,
      dunningFeesCentsBefore:          DUNNING_FEE_CENTS * 2,
      originalBillRands:               bill,
      today:                           day15,
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS);
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CAP_ABSOLUTE_CENTS);
    expect(r.capReached).toBe(true);
    expect(r.terminalStatus).toBe('defaulted');
    expect(r.nextAttemptDate).toBeNull();
  });
});

// ─── Small-bill cap short-circuit (R400 bill → R200 cap → 2 fees max) ───────

describe('advanceLadderAfterFailure — small-bill cap binds early', () => {
  const bill = 400; // 50% cap = R200 → 2 R100 fees → ladder stops there

  it('first fee attaches at Day 1, counter resets, schedule Day 7', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           '2026-06-16',
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS);
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CENTS);
    expect(r.capReached).toBe(false);
  });

  it('second fee attaches at Day 8 → cap = R200 reached → defaulted, no third pair', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,
      dunningFeesCentsBefore:          DUNNING_FEE_CENTS,
      originalBillRands:               bill,
      today:                           '2026-06-23',
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS);
    expect(r.dunningFeesCentsAfter).toBe(2 * DUNNING_FEE_CENTS); // R200
    expect(r.capReached).toBe(true);
    expect(r.terminalStatus).toBe('defaulted');
    expect(r.nextAttemptDate).toBeNull();
  });
});

// ─── Edge: tiny bill where one fee binds the cap below R100 ─────────────────

describe('advanceLadderAfterFailure — tiny-bill cap < single fee', () => {
  it('R150 bill (R75 cap): fee shrinks to R75; cap reached; defaulted', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,  // second-of-pair → would earn fee
      dunningFeesCentsBefore:          0,
      originalBillRands:               150,
      today:                           '2026-06-16',
    });
    expect(r.feeAppliedThisAttempt).toBe(7_500); // R75 (clamped to headroom)
    expect(r.dunningFeesCentsAfter).toBe(7_500);
    expect(r.capReached).toBe(true);
    expect(r.terminalStatus).toBe('defaulted');
    expect(r.nextAttemptDate).toBeNull();
  });
});
