// ─── Net income from gross, our own arithmetic ──────────────────────────
//
// Pure. No I/O, no dates, no env reads beyond what coefficients.ts already
// resolved at import.
//
// ─── WHY WE DO NOT USE EXPERIAN'S NET FIGURE ───────────────────────────
//
// The affordability reply carries `Cal_Net_Income_Amount`. We ignore it.
// Measured against our own calculation it runs roughly R880/month low at
// R66k gross, and a net figure that is understated by that much
// understates NDI, which understates the facility, which prices a limit
// below what the applicant can actually afford. Their number is not wrong
// so much as computed against assumptions we cannot see or version — and
// this project needs to be able to say which coefficients priced a given
// limit.
//
// So the bureau supplies the income PREDICTION (GMIP) and the expense
// snapshot; the tax treatment of that prediction is ours.
//
// ─── THE ORDER OF OPERATIONS MATTERS ───────────────────────────────────
//
// PAYE is annual and progressive, so it cannot be computed on a monthly
// figure and multiplied. The rebate is likewise annual, and deducting a
// monthly twelfth of it before the brackets would give a different — wrong
// — answer for anyone near a bracket edge. Hence: annualise, bracket,
// deduct the rebate, THEN divide by twelve.
//
// UIF is the opposite: its cap is expressed per month, so it is computed
// monthly and never annualised.

import {
  TAX_BRACKETS_2026_27,
  PRIMARY_REBATE_ANNUAL,
  UIF_RATE,
  UIF_MONTHLY_CAP,
} from './coefficients';

/**
 * Annual PAYE before any rebate, for a given annual taxable income.
 *
 * Walks the bracket table from the top so the first match is the
 * applicable bracket. A negative or zero income yields zero rather than
 * throwing — the callers upstream already reject non-finite income, and a
 * throw here would turn a data oddity into a 500 on a money path.
 */
export function annualPayeBeforeRebate(annualIncome: number): number {
  if (!Number.isFinite(annualIncome) || annualIncome <= 0) return 0;

  for (let i = TAX_BRACKETS_2026_27.length - 1; i >= 0; i -= 1) {
    const bracket = TAX_BRACKETS_2026_27[i];
    if (annualIncome > bracket.from) {
      return bracket.base + (annualIncome - bracket.from) * bracket.rate;
    }
  }
  // Only reachable for incomes at exactly 0 given the table starts at 0.
  return 0;
}

/**
 * Annual PAYE after the primary rebate, floored at zero.
 *
 * The floor is not cosmetic: below roughly R99k/year the rebate exceeds the
 * computed tax, and a negative "tax" would be added back as income.
 */
export function annualPayeAfterRebate(annualIncome: number): number {
  const gross = annualPayeBeforeRebate(annualIncome);
  return Math.max(0, gross - PRIMARY_REBATE_ANNUAL);
}

/**
 * Monthly UIF employee contribution: 1% of monthly gross, capped.
 *
 * The cap binds from R17,712/month upward, which is above the median
 * applicant here but well inside the range GMIP returns.
 */
export function monthlyUif(monthlyGross: number): number {
  if (!Number.isFinite(monthlyGross) || monthlyGross <= 0) return 0;
  return Math.min(monthlyGross * UIF_RATE, UIF_MONTHLY_CAP);
}

export type NetIncomeBreakdown = {
  /** The monthly gross we were handed. Echoed for the assessment log. */
  monthlyGross: number;
  /** Annualised gross — monthlyGross × 12. */
  annualGross: number;
  /** Annual PAYE after the primary rebate. */
  annualPaye: number;
  /** annualPaye ÷ 12. */
  monthlyPaye: number;
  /** Monthly UIF, capped. */
  monthlyUif: number;
  /** monthlyGross − monthlyPaye − monthlyUif. */
  monthlyNet: number;
};

/**
 * Full net-income breakdown for a monthly gross figure.
 *
 * Returns the intermediate values rather than just the net, because every
 * one of them is written to the assessment log — when a cohort goes bad we
 * need to see which step of the calculation drove the limit, not just the
 * limit.
 */
export function netIncomeFromMonthlyGross(monthlyGross: number): NetIncomeBreakdown {
  const gross       = Number.isFinite(monthlyGross) && monthlyGross > 0 ? monthlyGross : 0;
  const annualGross = gross * 12;
  const annualPaye  = annualPayeAfterRebate(annualGross);
  const monthlyPaye = annualPaye / 12;
  const uif         = monthlyUif(gross);

  return {
    monthlyGross: gross,
    annualGross,
    annualPaye,
    monthlyPaye,
    monthlyUif: uif,
    monthlyNet: gross - monthlyPaye - uif,
  };
}
