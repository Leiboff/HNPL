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
//   Attempt 2 (Day 1) fails → counter=0, +R115 fee   (end of pair)
//   Attempt 3 (Day 7) fails → counter=1, no fee
//   Attempt 4 (Day 8) fails → counter=0, +R115 fee   (end of pair)
//   Attempt 5 (Day 14) fails → counter=1, no fee
//   Attempt 6 (Day 15) fails → counter=0, +R115 fee  → cap reached → defaulted

describe('computeFeeCapCents — cap = min(R345, 50% of bill)', () => {
  it('large bill (≥R690) is bounded by the absolute cap (R345 = 3×R115)', () => {
    expect(computeFeeCapCents(1000)).toBe(34_500);
    expect(computeFeeCapCents(690)).toBe(34_500); // 50% of R690 = R345, ties the absolute
  });

  it('mid / small bill is bounded by the 50% cap', () => {
    expect(computeFeeCapCents(600)).toBe(30_000); // 50% of R600 = R300 < R345 absolute
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
    // One fee (R115) and the full cap (R345 = 3 fees), symbolic so they
    // track the constants.
    expect(chargeAmountCents(250, DUNNING_FEE_CENTS)).toBe(25_000 + DUNNING_FEE_CENTS);            // R365
    expect(chargeAmountCents(250, DUNNING_FEE_CAP_ABSOLUTE_CENTS)).toBe(25_000 + DUNNING_FEE_CAP_ABSOLUTE_CENTS); // R595
  });
});

// ─── Uneven-cents agreement: settle-all SUM == sum of individual Pay-now ─
//
// Real plans split into uneven cents because the first instalment absorbs
// the rounding remainder, e.g. R1,277.00 / 3 → R425.68 + R425.66 + R425.66.
// The settle-entire-bill RPC (claim_plan_for_settlement) sums in Postgres
// via `SUM(ROUND(amount*100)::BIGINT + COALESCE(dunning_fees_cents,0))`,
// while single-instalment Pay-now sums in JS via chargeAmountCents
// (Math.round(amount*100) + fees). For the two paths to agree to the cent,
// chargeAmountCents on each leg must produce the same per-leg cents PG
// computes — and the JS sum of those legs must equal the PG SUM.
//
// PG NUMERIC arithmetic on amount*100 is exact (NUMERIC(10,2) × INTEGER
// is NUMERIC, ROUND of an already-integer NUMERIC is the same integer).
// JS Math.round corrects the IEEE-754 drift on amount*100 (e.g.
// 425.68*100 may yield 42567.99999... in JS, Math.round → 42568).

describe('chargeAmountCents — fractional-rand instalments (R425.68 + R425.66 + R425.66)', () => {
  it('produces 42568 for R425.68 despite IEEE-754 drift on the multiply', () => {
    expect(chargeAmountCents(425.68, 0)).toBe(42_568);
  });

  it('produces 42566 for R425.66', () => {
    expect(chargeAmountCents(425.66, 0)).toBe(42_566);
  });

  it('JS sum of the three legs equals the SQL SUM expected from the RPC (127700)', () => {
    // Mirrors what the patient sees: if they tap Pay-now on each
    // instalment, the cumulative charge amount = 127700. The
    // claim_plan_for_settlement RPC sums in Postgres NUMERIC and
    // returns 127700 too. The two charge paths agree to the cent.
    const a = chargeAmountCents(425.68, 0);
    const b = chargeAmountCents(425.66, 0);
    const c = chargeAmountCents(425.66, 0);
    expect(a + b + c).toBe(127_700);
  });

  it('with accrued dunning fees mixed in: 3 instalments + one R115 fee on the failed one', () => {
    // R425.68 + R425.66 (with R115 fee) + R425.66 = R1,277 + R115 = R1,392 → 139200 cents
    const a = chargeAmountCents(425.68, 0);
    const b = chargeAmountCents(425.66, DUNNING_FEE_CENTS); // R115 fee on this leg
    const c = chargeAmountCents(425.66, 0);
    expect(a + b + c).toBe(127_700 + DUNNING_FEE_CENTS);
  });
});

// ─── Ladder progression on a typical R1000 bill (large bill, R345 cap) ──────

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

  it('Day 1 fail — second of pair, +R115 fee, counter resets, schedules Day 7', () => {
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

  it('Day 8 fail — second of pair, +R115 fee (#2), counter resets, schedules Day 14', () => {
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
  const bill = 400;                       // 50% cap = R200 = computeFeeCapCents(400)
  const cap  = computeFeeCapCents(bill);  // 20_000

  it('first fee attaches at Day 1 (full R115), counter resets, schedule Day 7', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           '2026-06-16',
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS); // R115, fits under R200
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CENTS);
    expect(r.capReached).toBe(false);
  });

  it('second fee at Day 8 CLAMPS to headroom (R85, not a full R115) → cap R200 reached → defaulted', () => {
    // After R115, only R85 of headroom remains under the R200 cap, so the
    // second fee shrinks to fit — proves the clamp tracks the fee constant.
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,
      dunningFeesCentsBefore:          DUNNING_FEE_CENTS,
      originalBillRands:               bill,
      today:                           '2026-06-23',
    });
    expect(r.feeAppliedThisAttempt).toBe(cap - DUNNING_FEE_CENTS); // 20_000 − 11_500 = 8_500 (R85)
    expect(r.dunningFeesCentsAfter).toBe(cap);                     // R200
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
