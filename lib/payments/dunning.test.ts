import { describe, it, expect } from 'vitest';
import {
  advanceLadderAfterFailure,
  chargeAmountCents,
  computeFeeCapCents,
  addDaysISO,
  DUNNING_FEE_CENTS,
  DUNNING_FEE_CAP_ABSOLUTE_CENTS,
  DUNNING_MAX_FEES,
  WEEKLY_RETRY_GAP_DAYS,
} from './dunning';

// ─── Pure math — ladder progression (fee on every failure, then weekly) ─────
//
// Decided cadence, per T&Cs clause 7.2: the due-date attempt IS the first
// collection try — there is no separate fee-free grace retry the day
// after. EVERY failure carries a fee and retries weekly, until 3 fees hit
// the cap → defaulted. `consecutiveFailedAttemptsBefore` is TOTAL failures
// so far (monotonic, never reset). Timeline on a normal bill:
//
//   Failure #1 (Day 0)  → +R115 fee #1, retry Day 7
//   Failure #2 (Day 7)  → +R115 fee #2, retry Day 14
//   Failure #3 (Day 14) → +R115 fee #3 → cap reached → defaulted
//
// A SECOND, independent stop condition bounds the same retry: the ladder
// never schedules a retry on or after the plan's NEXT instalment's own
// due date — see the `nextInstalmentDueDate` tests below.

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
// No next instalment near enough to bind — nextInstalmentDueDate: null
// throughout this block, so only the fee cap governs termination.

describe('advanceLadderAfterFailure — full timeline on a R1000 bill', () => {
  const bill = 1000;
  const day0  = '2026-06-15';
  const day7  = addDaysISO(day0, WEEKLY_RETRY_GAP_DAYS);  // 2026-06-22
  const day14 = addDaysISO(day7, WEEKLY_RETRY_GAP_DAYS);  // 2026-06-29

  it('Failure #1 (Day 0, the due-date attempt) — +R115 fee #1, schedules the weekly retry (Day 7)', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 0,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           day0,
      nextInstalmentDueDate:           null,
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS);
    expect(r.consecutiveFailedAttemptsAfter).toBe(1);
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CENTS);
    expect(r.capReached).toBe(false);
    expect(r.nextInstalmentBoundaryHit).toBe(false);
    expect(r.terminalStatus).toBeNull();
    expect(r.nextAttemptDate).toBe(day7);
  });

  it('Failure #2 (Day 7) — +R115 fee #2, schedules the next weekly retry (Day 14)', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,
      dunningFeesCentsBefore:          DUNNING_FEE_CENTS,
      originalBillRands:               bill,
      today:                           day7,
      nextInstalmentDueDate:           null,
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS);
    expect(r.consecutiveFailedAttemptsAfter).toBe(2);
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CENTS * 2);
    expect(r.capReached).toBe(false);
    expect(r.nextAttemptDate).toBe(day14);
  });

  it('Failure #3 (Day 14) — fee #3 lands → cap R345 reached → terminal defaulted', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 2,
      dunningFeesCentsBefore:          DUNNING_FEE_CENTS * 2,
      originalBillRands:               bill,
      today:                           day14,
      nextInstalmentDueDate:           null,
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS);
    expect(r.consecutiveFailedAttemptsAfter).toBe(3);
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CAP_ABSOLUTE_CENTS); // R345 = 3 fees
    expect(r.capReached).toBe(true);
    expect(r.nextInstalmentBoundaryHit).toBe(false);
    expect(r.terminalStatus).toBe('defaulted');
    expect(r.nextAttemptDate).toBeNull();
  });
});

// ─── Small-bill cap short-circuit (R400 bill → R200 cap → defaults early) ───

describe('advanceLadderAfterFailure — small-bill cap binds early', () => {
  const bill = 400;                       // 50% cap = R200 = computeFeeCapCents(400)
  const cap  = computeFeeCapCents(bill);  // 20_000

  it('Failure #1 (Day 0) — fee #1 (full R115) fits under R200, schedules weekly (Day 7)', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 0,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           '2026-06-15',
      nextInstalmentDueDate:           null,
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS); // R115, fits under R200
    expect(r.dunningFeesCentsAfter).toBe(DUNNING_FEE_CENTS);
    expect(r.capReached).toBe(false);
    expect(r.nextAttemptDate).toBe(addDaysISO('2026-06-15', WEEKLY_RETRY_GAP_DAYS));
  });

  it('Failure #2 (Day 7) — fee #2 CLAMPS to headroom (R85) → cap R200 reached → defaulted', () => {
    // After R115, only R85 of headroom remains under the R200 cap, so the
    // second fee shrinks to fit — proves the clamp tracks the fee constant.
    // The small bill therefore defaults ONE attempt sooner than a large one.
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 1,
      dunningFeesCentsBefore:          DUNNING_FEE_CENTS,
      originalBillRands:               bill,
      today:                           '2026-06-22',
      nextInstalmentDueDate:           null,
    });
    expect(r.feeAppliedThisAttempt).toBe(cap - DUNNING_FEE_CENTS); // 20_000 − 11_500 = 8_500 (R85)
    expect(r.dunningFeesCentsAfter).toBe(cap);                     // R200
    expect(r.consecutiveFailedAttemptsAfter).toBe(2);
    expect(r.capReached).toBe(true);
    expect(r.terminalStatus).toBe('defaulted');
    expect(r.nextAttemptDate).toBeNull();
  });
});

// ─── Edge: tiny bill where one fee binds the cap below R100 ─────────────────

describe('advanceLadderAfterFailure — tiny-bill cap < single fee', () => {
  it('R150 bill (R75 cap): the very first failure shrinks to R75; cap reached; defaulted', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 0,
      dunningFeesCentsBefore:          0,
      originalBillRands:               150,
      today:                           '2026-06-15',
      nextInstalmentDueDate:           null,
    });
    expect(r.feeAppliedThisAttempt).toBe(7_500); // R75 (clamped to headroom)
    expect(r.dunningFeesCentsAfter).toBe(7_500);
    expect(r.capReached).toBe(true);
    expect(r.terminalStatus).toBe('defaulted');
    expect(r.nextAttemptDate).toBeNull();
  });
});

// ─── The next-instalment boundary ────────────────────────────────────────
//
// Independent of the fee cap: the ladder never schedules a retry on or
// after the plan's next instalment's own due date. Product policy — any
// unresolved default freezes the patient (lib/patient/freeze.ts), so
// "stopped chasing it, still unpaid" must still terminate as defaulted
// even short of 3 fees, rather than silently retrying alongside a
// now-also-due next instalment.

describe('advanceLadderAfterFailure — bounded by the next instalment due date', () => {
  const bill = 1000; // large bill — fee cap (R345) would otherwise take 3 attempts

  it('boundary far away (>7 days out) — no effect, normal weekly retry scheduled', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 0,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           '2026-06-15',
      nextInstalmentDueDate:           '2026-08-01', // weeks away
    });
    expect(r.nextInstalmentBoundaryHit).toBe(false);
    expect(r.terminalStatus).toBeNull();
    expect(r.nextAttemptDate).toBe('2026-06-22');
  });

  it('proposed retry lands EXACTLY on the next instalment due date — boundary hit, terminal', () => {
    // today + 7 days = 2026-06-22, which is exactly the next instalment's
    // due date. The instalment stops being separately chased right there.
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 0,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           '2026-06-15',
      nextInstalmentDueDate:           '2026-06-22',
    });
    expect(r.feeAppliedThisAttempt).toBe(DUNNING_FEE_CENTS); // the fee for THIS failed attempt still applies
    expect(r.capReached).toBe(false);                        // nowhere near the R345 cap
    expect(r.nextInstalmentBoundaryHit).toBe(true);
    expect(r.terminalStatus).toBe('defaulted');
    expect(r.nextAttemptDate).toBeNull();
  });

  it('proposed retry lands AFTER the next instalment due date — boundary hit, terminal', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 0,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           '2026-06-15',
      nextInstalmentDueDate:           '2026-06-18', // short Pay-in-2 gap, already past by the time +7 lands
    });
    expect(r.nextInstalmentBoundaryHit).toBe(true);
    expect(r.terminalStatus).toBe('defaulted');
    expect(r.nextAttemptDate).toBeNull();
  });

  it('proposed retry lands ONE DAY before the boundary — not hit, retry still scheduled', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 0,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           '2026-06-15',
      nextInstalmentDueDate:           '2026-06-23', // one day after the proposed 2026-06-22 retry
    });
    expect(r.nextInstalmentBoundaryHit).toBe(false);
    expect(r.terminalStatus).toBeNull();
    expect(r.nextAttemptDate).toBe('2026-06-22');
  });

  it('last instalment on the plan (nextInstalmentDueDate: null) — only the fee cap governs', () => {
    const r = advanceLadderAfterFailure({
      consecutiveFailedAttemptsBefore: 0,
      dunningFeesCentsBefore:          0,
      originalBillRands:               bill,
      today:                           '2026-06-15',
      nextInstalmentDueDate:           null,
    });
    expect(r.nextInstalmentBoundaryHit).toBe(false);
    expect(r.terminalStatus).toBeNull();
    expect(r.nextAttemptDate).toBe('2026-06-22');
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
  it('runs Day 0/7/14 with fees [R115, R115, R115] then terminal defaulted', () => {
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
        nextInstalmentDueDate:           null,
      });
      feesPerAttempt.push(r.feeAppliedThisAttempt);
      counter  = r.consecutiveFailedAttemptsAfter;
      fees     = r.dunningFeesCentsAfter;
      terminal = r.terminalStatus;
      today    = r.nextAttemptDate; // null terminates the loop
    }

    // Exactly 3 attempts: the due-date attempt + 2 further weekly retries.
    expect(days).toEqual(['2026-06-15', '2026-06-22', '2026-06-29']);
    // Every attempt carries a full R115 (R1000 bill never clamps).
    expect(feesPerAttempt).toEqual([DUNNING_FEE_CENTS, DUNNING_FEE_CENTS, DUNNING_FEE_CENTS]);
    // 3 fees total = R345 cap; terminal defaulted.
    expect(fees).toBe(DUNNING_FEE_CAP_ABSOLUTE_CENTS);
    expect(feesPerAttempt.filter((f) => f > 0)).toHaveLength(DUNNING_MAX_FEES);
    expect(counter).toBe(3);
    expect(terminal).toBe('defaulted');
  });
});
