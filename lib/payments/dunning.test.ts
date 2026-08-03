import { describe, it, expect } from 'vitest';
import {
  advanceLadderAfterFailure,
  chargeAmountCents,
  computeFeeCapCents,
  addDaysISO,
  DUNNING_FEE_CENTS,
  DUNNING_FEE_CAP_ABSOLUTE_CENTS,
  DUNNING_MAX_FEES,
  FIRST_RETRY_GAP_DAYS,
  WEEKLY_RETRY_GAP_DAYS,
} from './dunning';

// ─── Pure math — ladder progression (fee on first default, then weekly) ─────
//
// The decided cadence: the first miss is a fee-free grace (retry +1 day);
// every failure after that carries a fee and retries weekly, until 3 fees
// hit the cap → defaulted. `consecutiveFailedAttemptsBefore` is TOTAL
// failures so far (monotonic, never reset). Timeline on a normal bill:
//
//   Failure #1 (Day 0)  → no fee, retry Day 1
//   Failure #2 (Day 1)  → +R115 fee #1, retry Day 8   (weekly)
//   Failure #3 (Day 8)  → +R115 fee #2, retry Day 15
//   Failure #4 (Day 15) → +R115 fee #3 → cap reached → defaulted

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

// ─── Full ladder timeline on a typical R1000 bill (large bill, R345 cap) ────

describe('advanceLadderAfterFailure — full timeline on a R1000 bill', () => {
  const bill = 1000;
  const day0 = '2026-06-15';
  const day1 = addDaysISO(day0, FIRST_RETRY_GAP_DAYS);   // 2026-06-16
  const day8 = addDaysISO(day1, WEEKLY_RETRY_GAP_DAYS);  // 2026-06-23
  const day15 = addDaysISO(day8, WEEKLY_RETRY_GAP_DAYS); // 2026-06-30

  it('Failure #1 (Day 0) — grace, NO fee, schedules the +1-day retry (Day 1)', () => {
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
    expect(r.nextAttemptDate).toBe(day1);
  });

  it('Failure #2 (Day 1) — first default, +R115 fee #1, schedules the weekly retry (Day 8)', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           day1,
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS);
    expect(r.consecutiveFailedAttemptsAfter).toBe(2);
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CENTS);
    expect(r.capReached).toBe(false);
    expect(r.nextAttemptDate).toBe(day8);
  });

  it('Failure #3 (Day 8) — +R115 fee #2, schedules the next weekly retry (Day 15)', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 2,
      dunningFeesCentsBefore:          DUNNING_FEE_CENTS,
      originalBillRands:               bill,
      today:                           day8,
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS);
    expect(r.consecutiveFailedAttemptsAfter).toBe(3);
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CENTS * 2);
    expect(r.capReached).toBe(false);
    expect(r.nextAttemptDate).toBe(day15);
  });

  it('Failure #4 (Day 15) — fee #3 lands → cap R345 reached → terminal defaulted', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 3,
      dunningFeesCentsBefore:          DUNNING_FEE_CENTS * 2,
      originalBillRands:               bill,
      today:                           day15,
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS);
    expect(r.consecutiveFailedAttemptsAfter).toBe(4);
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CAP_ABSOLUTE_CENTS); // R345 = 3 fees
    expect(r.capReached).toBe(true);
    expect(r.terminalStatus).toBe('defaulted');
    expect(r.nextAttemptDate).toBeNull();
  });
});

// ─── Small-bill cap short-circuit (R400 bill → R200 cap → defaults early) ───

describe('advanceLadderAfterFailure — small-bill cap binds early', () => {
  const bill = 400;                       // 50% cap = R200 = computeFeeCapCents(400)
  const cap  = computeFeeCapCents(bill);  // 20_000

  it('Failure #1 (Day 0) — grace, no fee, schedules Day 1', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 0,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           '2026-06-15',
    });
    expect(r.feeAppliedThisAttempt).toBe(0);
    expect(r.nextAttemptDate).toBe(addDaysISO('2026-06-15', FIRST_RETRY_GAP_DAYS));
    expect(r.capReached).toBe(false);
  });

  it('Failure #2 (Day 1) — fee #1 (full R115) fits under R200, schedules weekly (Day 8)', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           '2026-06-16',
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS); // R115, fits under R200
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CENTS);
    expect(r.capReached).toBe(false);
    expect(r.nextAttemptDate).toBe(addDaysISO('2026-06-16', WEEKLY_RETRY_GAP_DAYS));
  });

  it('Failure #3 (Day 8) — fee #2 CLAMPS to headroom (R85) → cap R200 reached → defaulted', () => {
    // After R115, only R85 of headroom remains under the R200 cap, so the
    // second fee shrinks to fit — proves the clamp tracks the fee constant.
    // The small bill therefore defaults ONE attempt sooner than a large one.
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 2,
      dunningFeesCentsBefore:          DUNNING_FEE_CENTS,
      originalBillRands:               bill,
      today:                           '2026-06-23',
    });
    expect(r.feeAppliedThisAttempt).toBe(cap - DUNNING_FEE_CENTS); // 20_000 − 11_500 = 8_500 (R85)
    expect(r.dunningFeesCentsAfter).toBe(cap);                     // R200
    expect(r.consecutiveFailedAttemptsAfter).toBe(3);
    expect(r.capReached).toBe(true);
    expect(r.terminalStatus).toBe('defaulted');
    expect(r.nextAttemptDate).toBeNull();
  });
});

// ─── Edge: tiny bill where one fee binds the cap below R100 ─────────────────

describe('advanceLadderAfterFailure — tiny-bill cap < single fee', () => {
  it('R150 bill (R75 cap): first fee-bearing failure (#2) shrinks to R75; cap reached; defaulted', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,  // failure #2 → fee-bearing
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

// ─── Adversarial: drive the whole ladder as a loop (output → next input) ────
//
// Feeds each attempt's real outputs (counter, accrued fees, next date) into
// the following attempt — exactly how the webhook persists + the cron
// re-reads. Pins the ENTIRE cadence end-to-end so a schedule regression
// can't slip past the per-step tests: which days, which attempts carry a
// fee, and where it terminates.

describe('advanceLadderAfterFailure — end-to-end ladder run (R1000 bill)', () => {
  it('runs Day 0/1/8/15 with fees [0, R115, R115, R115] then terminal defaulted', () => {
    const bill = 1000;
    let counter = 0;
    let fees    = 0;
    let today: string | null = '2026-06-15';

    const days:  string[] = [];
    const feesPerAttempt: number[] = [];
    let terminal: string | null = null;
    let guard = 0;

    while (today && guard++ < 10) {
      days.push(today);
      const r = advanceLadderAfterFailure({
        consecutiveFailedAttemptsBefore: counter,
        dunningFeesCentsBefore:          fees,
        originalBillRands:               bill,
        today,
      });
      feesPerAttempt.push(r.feeAppliedThisAttempt);
      counter  = r.consecutiveFailedAttemptsAfter;
      fees     = r.dunningFeesCentsAfter;
      terminal = r.terminalStatus;
      today    = r.nextAttemptDate; // null terminates the loop
    }

    // Exactly 4 attempts: Day 0 (grace) + 3 weekly fee-bearing.
    expect(days).toEqual(['2026-06-15', '2026-06-16', '2026-06-23', '2026-06-30']);
    // Day 0 free; every later attempt carries a full R115 (R1000 bill never clamps).
    expect(feesPerAttempt).toEqual([0, DUNNING_FEE_CENTS, DUNNING_FEE_CENTS, DUNNING_FEE_CENTS]);
    // 3 fees total = R345 cap; terminal defaulted.
    expect(fees).toBe(DUNNING_FEE_CAP_ABSOLUTE_CENTS);
    expect(feesPerAttempt.filter((f) => f > 0)).toHaveLength(DUNNING_MAX_FEES);
    expect(counter).toBe(4);
    expect(terminal).toBe('defaulted');
  });
});
