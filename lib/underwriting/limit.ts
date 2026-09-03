// ─── The limit calculation. Pure, and the only place it happens ─────────
//
// No network, no database, no clock, no env reads of its own. Hand it
// numbers, get a decision. Everything it needs that could change is in
// coefficients.ts behind a version string.
//
// The output is the patient's TOTAL STANDING LIMIT — not a per-plan
// amount. Individual plans draw against it later (see claimCredit.ts);
// nothing in this file knows plans exist.
//
// ─── DECLARED INCOME CANNOT RAISE A LIMIT, BY CONSTRUCTION ─────────────
//
// The income page collects a declared gross figure. It is allowed to LOWER
// a limit (if the patient says they earn less than Experian predicts, we
// believe the patient) and never to raise one (otherwise the limit is
// self-certified and the whole point of paying for a prediction is gone).
//
// Enforcing that with a comment and a code review is not enough on a money
// path, so the two figures are separate BRANDED types. `PredictedGross`
// and `DeclaredGross` are both numbers at runtime and mutually
// unassignable at compile time, and the only constructors are the two
// functions below. There is no call signature in this module that accepts
// a declared figure where a predicted one belongs — passing them in the
// wrong order does not type-check, and `resolveIncomeBasis` is the single
// place the two ever meet.
//
// ─── WHY A NULL PREDICTION IS NOT AN ERROR ─────────────────────────────
//
// `prediction: null` is the thin-file path: Low confidence, "Unable To
// Determine GMIP", a -209 or a -217. Experian answered; the answer is "no
// usable prediction". The formula cannot run without an income figure, so
// the limit falls back to the band ceiling — which for every route that
// produces a null prediction is the thin-file R1,000. That is a GRANT, not
// a decline, and it is deliberately distinct from the technical-failure
// path (a fault, a timeout, a -106) which never reaches this function at
// all because it resolves to pending upstream.

import {
  BAND_CEILINGS,
  FACILITY_MONTHS,
  LIMIT_ROUNDING_STEP,
  LIVING_EXPENSE_FLOOR_RATIO,
  MEDIUM_CONFIDENCE_HAIRCUT,
  MINIMUM_LIMIT,
  NDI_INSTALMENT_RATIO,
  COEFFICIENT_VERSION,
  type ScorecardBand,
} from './coefficients';
import { netIncomeFromMonthlyGross, type NetIncomeBreakdown } from './tax';

// ── The two income types ───────────────────────────────────────────────

declare const PREDICTED: unique symbol;
declare const DECLARED:  unique symbol;

/** Experian's `GMIP_Value` — a predicted monthly gross. */
export type PredictedGross = number & { readonly [PREDICTED]: true };

/** The patient's own stated monthly gross, from the income page. */
export type DeclaredGross = number & { readonly [DECLARED]: true };

/** Tag a bureau-predicted monthly gross. Rejects non-finite / non-positive input. */
export function predictedGross(value: number): PredictedGross {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('predictedGross requires a finite positive monthly figure');
  }
  return value as PredictedGross;
}

/** Tag a patient-declared monthly gross. Rejects non-finite / non-positive input. */
export function declaredGross(value: number): DeclaredGross {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('declaredGross requires a finite positive monthly figure');
  }
  return value as DeclaredGross;
}

/**
 * The ONLY place a declared figure meets a predicted one.
 *
 * `min` is the whole rule: below the prediction it wins, at or above it is
 * ignored. Exported so the property can be tested directly rather than
 * only through the full calculation.
 */
export function resolveIncomeBasis(
  predicted: PredictedGross | null,
  declared:  DeclaredGross | null,
): number | null {
  if (predicted === null) return declared === null ? null : (declared as number);
  if (declared  === null) return predicted as number;
  return Math.min(predicted as number, declared as number);
}

// ── Inputs and outputs ─────────────────────────────────────────────────

/**
 * A usable GMIP prediction. Only High and Medium confidence get here —
 * Low and "Unable To Determine GMIP" are mapped to a null prediction plus
 * the thin-file band by the caller, because they carry no income figure to
 * compute against.
 */
export type GmipPrediction = {
  gross: PredictedGross;
  confidence: 'High' | 'Medium';
  /** Experian's `Bureau_Expenses` — existing monthly credit obligations. */
  bureauExpenses: number;
  /** Experian's `Calc_Living_Expenses` — the statutory-norm living figure. */
  calcLivingExpenses: number;
};

export type LimitInput = {
  band: ScorecardBand;
  /** Null on every thin-file route. See the header. */
  prediction: GmipPrediction | null;
  /** Null when the patient has not given a figure. */
  declared: DeclaredGross | null;
};

/** Which of the four constraints produced the final number. */
export type BindingConstraint =
  /** The affordability formula — NDI × ratio × months. */
  | 'formula'
  /** The scorecard band's hard ceiling. */
  | 'band_ceiling'
  /** One month's income (predicted, or declared where lower). */
  | 'income_cap'
  /** Fell under the R1,000 floor after rounding — always a decline. */
  | 'minimum';

/**
 * Every intermediate figure, for `credit_assessments`. Written on approvals
 * AND declines: a decline with no workings tells us nothing at calibration
 * time, and declines are half the population we need to see.
 */
export type LimitWorkings = {
  coefficientVersion: string;
  band: ScorecardBand;
  /** Null when there was no prediction to work from. */
  net: NetIncomeBreakdown | null;
  /** The income figure the calculation actually used. */
  incomeBasis: number | null;
  /** True when the declared figure came in below the prediction and replaced it. */
  declaredLoweredBasis: boolean;
  /** max(Calc_Living_Expenses, 25% of net). Null with no prediction. */
  living: number | null;
  /** Which side of that max won — useful for spotting implausible bureau expense data. */
  livingSource: 'bureau_norm' | 'net_floor' | null;
  /** net − Bureau_Expenses − living. Null with no prediction. */
  ndi: number | null;
  /** NDI × ratio, after any Medium haircut. Null with no prediction. */
  monthly: number | null;
  /** True when the Medium-confidence haircut was applied. */
  haircutApplied: boolean;
  /** monthly × FACILITY_MONTHS. Null with no prediction. */
  facility: number | null;
  /** The band ceiling in force. Null means the band declines. */
  bandCeiling: number | null;
  /** The limit before rounding. */
  rawLimit: number | null;
};

export type LimitOutcome =
  | { decision: 'approved'; limit: number; binding: BindingConstraint; workings: LimitWorkings }
  | {
      decision: 'declined';
      /** `band` — the scorecard declines outright. `below_minimum` — the
       *  arithmetic produced less than R1,000. Different copy, same log table. */
      reason: 'band' | 'below_minimum';
      binding: BindingConstraint;
      workings: LimitWorkings;
    };

/** Round DOWN to a multiple of the configured step. Never up. */
export function roundDownToStep(value: number, step: number = LIMIT_ROUNDING_STEP): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / step) * step;
}

/**
 * The calculation.
 *
 *   net      = SARS PAYE + UIF applied to the income basis
 *   living   = max(Calc_Living_Expenses, 0.25 × net)
 *   NDI      = net − Bureau_Expenses − living
 *   monthly  = NDI × 0.20   (× 0.85 if confidence is Medium)
 *   facility = monthly × 3
 *   limit    = min(facility, band ceiling, income basis)
 *   limit    = round down to nearest 500
 *
 * Declined when the band has no ceiling, or when the rounded limit is
 * below R1,000.
 */
export function calculateCreditLimit(input: LimitInput): LimitOutcome {
  const bandCeiling = BAND_CEILINGS[input.band];
  const predicted   = input.prediction?.gross ?? null;
  const incomeBasis = resolveIncomeBasis(predicted, input.declared);

  const declaredLoweredBasis =
    predicted !== null
    && input.declared !== null
    && (input.declared as number) < (predicted as number);

  // ── The band gate, defensively ───────────────────────────────────────
  //
  // A declining band should never reach this function: the score gate
  // refuses the application before the affordability call is made, so
  // there is no GMIP to compute from. It is checked anyway because "two
  // gates disagree about whether you may borrow" is how the F-05 hole
  // opened, and a null ceiling reaching the arithmetic below would read as
  // an unbounded limit rather than a refusal.
  if (bandCeiling === null) {
    return {
      decision: 'declined',
      reason:   'band',
      binding:  'band_ceiling',
      workings: {
        coefficientVersion: COEFFICIENT_VERSION,
        band: input.band,
        net: null,
        incomeBasis,
        declaredLoweredBasis,
        living: null,
        livingSource: null,
        ndi: null,
        monthly: null,
        haircutApplied: false,
        facility: null,
        bandCeiling: null,
        rawLimit: null,
      },
    };
  }

  // ── The thin-file path: no prediction, so no formula ─────────────────
  if (input.prediction === null) {
    // The income cap still applies. A patient who declares R800/month does
    // not get a R1,000 facility just because the band ceiling allows one.
    const capped   = incomeBasis === null ? bandCeiling : Math.min(bandCeiling, incomeBasis);
    const rounded  = roundDownToStep(capped);
    const binding: BindingConstraint =
      incomeBasis !== null && incomeBasis < bandCeiling ? 'income_cap' : 'band_ceiling';

    const workings: LimitWorkings = {
      coefficientVersion: COEFFICIENT_VERSION,
      band: input.band,
      net: null,
      incomeBasis,
      declaredLoweredBasis,
      living: null,
      livingSource: null,
      ndi: null,
      monthly: null,
      haircutApplied: false,
      facility: null,
      bandCeiling,
      rawLimit: capped,
    };

    if (rounded < MINIMUM_LIMIT) {
      return { decision: 'declined', reason: 'below_minimum', binding: 'minimum', workings };
    }
    return { decision: 'approved', limit: rounded, binding, workings };
  }

  // ── The full formula ─────────────────────────────────────────────────
  const basis = incomeBasis as number;
  const net   = netIncomeFromMonthlyGross(basis);

  const netFloor     = net.monthlyNet * LIVING_EXPENSE_FLOOR_RATIO;
  const bureauNorm   = input.prediction.calcLivingExpenses;
  const living       = Math.max(bureauNorm, netFloor);
  const livingSource = bureauNorm >= netFloor ? 'bureau_norm' as const : 'net_floor' as const;

  const ndi = net.monthlyNet - input.prediction.bureauExpenses - living;

  const haircutApplied = input.prediction.confidence === 'Medium';
  const monthly = Math.max(0, ndi) * NDI_INSTALMENT_RATIO
    * (haircutApplied ? MEDIUM_CONFIDENCE_HAIRCUT : 1);

  const facility = monthly * FACILITY_MONTHS;

  // min(facility, ceiling, income). Ties resolve toward the formula: when
  // the arithmetic lands exactly on a cap, the calculation is what produced
  // the number and the cap is not restricting anything.
  const rawLimit = Math.min(facility, bandCeiling, basis);
  const binding: BindingConstraint =
      facility    <= rawLimit ? 'formula'
    : basis       <= rawLimit ? 'income_cap'
    :                           'band_ceiling';

  const rounded = roundDownToStep(rawLimit);

  const workings: LimitWorkings = {
    coefficientVersion: COEFFICIENT_VERSION,
    band: input.band,
    net,
    incomeBasis: basis,
    declaredLoweredBasis,
    living,
    livingSource,
    ndi,
    monthly,
    haircutApplied,
    facility,
    bandCeiling,
    rawLimit,
  };

  if (rounded < MINIMUM_LIMIT) {
    return { decision: 'declined', reason: 'below_minimum', binding: 'minimum', workings };
  }
  return { decision: 'approved', limit: rounded, binding, workings };
}
