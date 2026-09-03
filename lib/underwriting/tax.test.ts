import { describe, it, expect } from 'vitest';
import {
  annualPayeBeforeRebate,
  annualPayeAfterRebate,
  monthlyUif,
  netIncomeFromMonthlyGross,
} from './tax';
import {
  TAX_BRACKETS_2026_27,
  PRIMARY_REBATE_ANNUAL,
  UIF_MONTHLY_CAP,
} from './coefficients';

// ─── The table is checked by arithmetic, not by eye ─────────────────────
//
// A mistyped `base` is invisible on inspection and shifts every limit
// above that bracket. The continuity property catches it: the cumulative
// tax at the bottom of bracket N must equal the cumulative tax at the top
// of bracket N-1.

describe('SARS 2026/27 bracket table is internally consistent', () => {
  it('each base equals the previous bracket walked to its full width', () => {
    for (let i = 1; i < TAX_BRACKETS_2026_27.length; i += 1) {
      const prev = TAX_BRACKETS_2026_27[i - 1];
      const here = TAX_BRACKETS_2026_27[i];
      const walked = prev.base + (here.from - prev.from) * prev.rate;
      expect(walked, `bracket ${i} base`).toBeCloseTo(here.base, 6);
    }
  });

  it('brackets ascend and rates are progressive', () => {
    for (let i = 1; i < TAX_BRACKETS_2026_27.length; i += 1) {
      expect(TAX_BRACKETS_2026_27[i].from).toBeGreaterThan(TAX_BRACKETS_2026_27[i - 1].from);
      expect(TAX_BRACKETS_2026_27[i].rate).toBeGreaterThan(TAX_BRACKETS_2026_27[i - 1].rate);
    }
  });
});

describe('annualPayeBeforeRebate — every bracket boundary', () => {
  it('the first bracket is a flat 18%', () => {
    expect(annualPayeBeforeRebate(100_000)).toBeCloseTo(18_000, 6);
    expect(annualPayeBeforeRebate(245_100)).toBeCloseTo(44_118, 6);
  });

  it.each(TAX_BRACKETS_2026_27.slice(1).map((b, i) => [i + 1, b.from, b.base] as const))(
    'bracket %i: income exactly at %i yields the published base %i',
    (_i, from, base) => {
      expect(annualPayeBeforeRebate(from)).toBeCloseTo(base, 6);
    },
  );

  it.each(TAX_BRACKETS_2026_27.slice(1).map((b) => [b.from, b.base, b.rate] as const))(
    'one rand above %i charges the new marginal rate',
    (from, base, rate) => {
      expect(annualPayeBeforeRebate(from + 1)).toBeCloseTo(base + rate, 6);
    },
  );

  it('the top bracket has no ceiling', () => {
    expect(annualPayeBeforeRebate(3_000_000))
      .toBeCloseTo(666_339 + (3_000_000 - 1_878_600) * 0.45, 6);
  });

  it('zero and negative income owe nothing rather than throwing', () => {
    expect(annualPayeBeforeRebate(0)).toBe(0);
    expect(annualPayeBeforeRebate(-1)).toBe(0);
    expect(annualPayeBeforeRebate(NaN)).toBe(0);
  });
});

describe('the primary rebate floors at zero', () => {
  it('deducts the rebate for a taxpayer above the threshold', () => {
    expect(annualPayeAfterRebate(360_000))
      .toBeCloseTo(annualPayeBeforeRebate(360_000) - PRIMARY_REBATE_ANNUAL, 6);
  });

  it('never returns a negative tax — a low earner owes zero, not a credit', () => {
    // 18% of 90,000 is 16,200, which is less than the 17,820 rebate.
    expect(annualPayeBeforeRebate(90_000)).toBeCloseTo(16_200, 6);
    expect(annualPayeAfterRebate(90_000)).toBe(0);
  });

  it('the tax threshold sits where 18% of income equals the rebate', () => {
    const threshold = PRIMARY_REBATE_ANNUAL / 0.18; // 99,000
    expect(annualPayeAfterRebate(threshold)).toBeCloseTo(0, 6);
    expect(annualPayeAfterRebate(threshold + 1_000)).toBeGreaterThan(0);
  });
});

describe('UIF is 1% of gross, capped monthly', () => {
  it('charges 1% below the cap', () => {
    expect(monthlyUif(10_000)).toBeCloseTo(100, 6);
  });

  it('caps at R177.12', () => {
    expect(monthlyUif(50_000)).toBe(UIF_MONTHLY_CAP);
  });

  it('the cap binds from R17,712/month upward', () => {
    expect(monthlyUif(17_711)).toBeCloseTo(177.11, 6);
    expect(monthlyUif(17_712)).toBeCloseTo(UIF_MONTHLY_CAP, 6);
    expect(monthlyUif(17_713)).toBe(UIF_MONTHLY_CAP);
  });

  it('is never annualised — the cap is a monthly figure', () => {
    // A naive annual treatment would give 12 × 177.12 = 2,125.44/month.
    expect(monthlyUif(1_000_000)).toBe(UIF_MONTHLY_CAP);
  });
});

describe('netIncomeFromMonthlyGross', () => {
  it('annualises, brackets, rebates, then divides by twelve', () => {
    const net = netIncomeFromMonthlyGross(30_000);
    expect(net.annualGross).toBe(360_000);
    // 44,118 + 26% of 114,900 = 73,992; less the 17,820 rebate = 56,172.
    expect(net.annualPaye).toBeCloseTo(56_172, 6);
    expect(net.monthlyPaye).toBeCloseTo(4_681, 6);
    expect(net.monthlyUif).toBe(UIF_MONTHLY_CAP);
    expect(net.monthlyNet).toBeCloseTo(30_000 - 4_681 - 177.12, 6);
  });

  it('does not deduct a monthly twelfth of the rebate before bracketing', () => {
    // The wrong order gives a different answer for anyone near an edge.
    // Annualise-then-rebate is the only order that matches SARS.
    const gross = 245_100 / 12;
    const net = netIncomeFromMonthlyGross(gross);
    expect(net.annualPaye).toBeCloseTo(44_118 - PRIMARY_REBATE_ANNUAL, 6);
  });

  it('a below-threshold earner pays no PAYE but still pays UIF', () => {
    const net = netIncomeFromMonthlyGross(7_000);
    expect(net.annualPaye).toBe(0);
    expect(net.monthlyPaye).toBe(0);
    expect(net.monthlyUif).toBeCloseTo(70, 6);
    expect(net.monthlyNet).toBeCloseTo(6_930, 6);
  });

  it('never reports a net above gross', () => {
    for (const gross of [1_000, 8_000, 25_000, 66_000, 200_000]) {
      const net = netIncomeFromMonthlyGross(gross);
      expect(net.monthlyNet).toBeLessThanOrEqual(gross);
      expect(net.monthlyNet).toBeGreaterThan(0);
    }
  });
});
