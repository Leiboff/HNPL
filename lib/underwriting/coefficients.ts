// ─── Versioned pricing coefficients ─────────────────────────────────────
//
// Every number that moves a credit limit lives here, behind a VERSION
// string that is written onto each row of `credit_assessments`. That is the
// whole point: at a few hundred outcomes we recalibrate, and a limit priced
// in March under one set of coefficients has to be distinguishable from the
// same applicant repriced in September under another. A constant inlined at
// its call site is invisible to that join.
//
// So: no magic numbers in tax.ts, limit.ts or the pipeline. If a value
// influences a rand figure a patient sees, it is defined in this file and
// read from `COEFFICIENTS`.
//
// ─── BUMPING THE VERSION ───────────────────────────────────────────────
//
// Change ANY value below and you MUST bump COEFFICIENT_VERSION in the same
// commit. `coefficients.test.ts` pins the current version against a digest
// of the values, so an edit without a bump fails the suite rather than
// silently poisoning the calibration data.
//
// The version is a date-stamped label, not a semver: it names the tax year
// and the revision within it, because the SARS tables are the part most
// likely to force a change and they change annually.

/** Written to `credit_assessments.coefficient_version` on every row. */
export const COEFFICIENT_VERSION = '2026.27-r2';

// ── SARS PAYE, 2026/27 tax year (1 Mar 2026 – 28 Feb 2027) ─────────────
//
// Annual taxable income brackets. `base` is the cumulative tax at the
// bottom of the bracket; `rate` applies to the portion above `from`.
//
// Each `base` is the previous bracket's base plus its full width at its own
// rate — a property `tax.test.ts` asserts directly, so a mistyped table is
// caught by arithmetic rather than by a patient getting the wrong limit.

export type TaxBracket = {
  /** Lower bound of the bracket, in annual rands (inclusive). */
  from: number;
  /** Cumulative tax owed at exactly `from`. */
  base: number;
  /** Marginal rate on income above `from`. */
  rate: number;
};

export const TAX_BRACKETS_2026_27: readonly TaxBracket[] = [
  { from:         0, base:       0, rate: 0.18 },
  { from:   245_100, base:  44_118, rate: 0.26 },
  { from:   383_100, base:  79_998, rate: 0.31 },
  { from:   530_200, base: 125_599, rate: 0.36 },
  { from:   695_800, base: 185_215, rate: 0.39 },
  { from:   887_000, base: 259_783, rate: 0.41 },
  { from: 1_878_600, base: 666_339, rate: 0.45 },
] as const;

/** SARS primary rebate, annual rands. Deducted from annual PAYE, floored at 0. */
export const PRIMARY_REBATE_ANNUAL = 17_820;

/** UIF employee contribution: 1% of gross, capped per month. */
export const UIF_RATE = 0.01;
export const UIF_MONTHLY_CAP = 177.12;

// ── Affordability overlay ──────────────────────────────────────────────

/**
 * Living expenses are the GREATER of Experian's `Calc_Living_Expenses` and
 * this share of net income. The floor exists because a bureau-derived
 * expense figure can come back implausibly low for a consumer with little
 * reported activity, and treating that as real disposable income is how a
 * thin file turns into an over-extension.
 */
export const LIVING_EXPENSE_FLOOR_RATIO = 0.25;

/** Share of net disposable income we are willing to see committed monthly. */
export const NDI_INSTALMENT_RATIO = 0.20;

/**
 * Haircut applied when Experian rates its own income prediction "Medium".
 * High takes no haircut; Low and "Unable To Determine GMIP" do not reach
 * this step at all — they are thin-file treated before the formula runs.
 */
export const MEDIUM_CONFIDENCE_HAIRCUT = 0.85;

/**
 * Facility = monthly affordability × this. Three months matches the longest
 * plan we write (pay-in-3), so the facility is what a patient could clear
 * over one full plan term at the monthly figure above.
 */
export const FACILITY_MONTHS = 3;

/** Limits round DOWN to a multiple of this. Never up — rounding up lends money the formula did not justify. */
export const LIMIT_ROUNDING_STEP = 500;

/** Below this, after rounding, the application is declined outright. */
export const MINIMUM_LIMIT = 1_000;

// ── Band ceilings ──────────────────────────────────────────────────────
//
// The hard cap per scorecard band, applied after the formula. `null` means
// the band is a DECLINE — not a zero limit, a decline, which is a different
// row in the assessment log and different copy for the patient.
//
// The band vocabulary is Experian's own (spec §4.1, §5.3): Very High Risk,
// High Risk, Average Risk, Low Risk, Minimum Risk. There is no "below
// average risk" band despite the phrase being in common use — the two bands
// below Average are High and Very High, and both decline.

export type ScorecardBand =
  | 'minimum'
  | 'low'
  | 'average'
  | 'high'
  | 'very_high'
  | 'thin_file';

export const BAND_CEILINGS: Readonly<Record<ScorecardBand, number | null>> = {
  minimum:   15_000,
  low:       10_000,
  average:    3_000,
  /** Thin file, and the low-confidence / no-GMIP paths that resolve to it. */
  thin_file:  1_000,
  high:        null,
  very_high:   null,
} as const;

// ── Per-scorecard limit caps ──────────────────────────────────────────
//
// A ceiling applied ON TOP of the band ceiling, keyed on the card that
// actually decided. The band says how likely this person is to default;
// this says how much we trust the card that produced the band.
//
// ─── WHY SIGMA TRANSCEND IS CAPPED AT R1,000 ───────────────────────────
//
// Transcend is the thin-file card: it scores people the traditional
// models cannot, from non-traditional data. Reading it lets us serve
// applicants who would otherwise be declined outright — which is why the
// fallback exists — but a Low Risk on Transcend is not the same evidence
// as a Low Risk on Sigma Unsecured Credit, and it should not buy the same
// exposure.
//
// Without this, the captured UAT applicant (unscorable on SU, 620 on STS)
// would price at R10,000 off a card built for people with almost no
// credit history. With it they get R1,000 — the thin-file amount, which
// is what they are.
//
// The BAND still does its job: a Very High Risk on Transcend declines,
// it does not get capped to R1,000. We take the risk signal and decline
// on it; we just do not take the exposure.
//
// Recorded separately from the band ceiling in the assessment log
// (binding_constraint = 'scorecard_cap'), so the real band stays visible
// and this cap can be relaxed on evidence rather than guesswork once
// there are Transcend-priced outcomes to look at.

export const SCORECARD_LIMIT_CAPS: Readonly<Record<string, number>> = {
  STS: 1_000,
} as const;

/** The cap in force for a scorecard, or null when it is uncapped. */
export function scorecardCapFor(resultType: string | null | undefined): number | null {
  if (!resultType) return null;
  return SCORECARD_LIMIT_CAPS[resultType.trim().toUpperCase()] ?? null;
}

// ── Lifecycle windows ──────────────────────────────────────────────────
//
// Both are env-overridable so they can be shortened in UAT without a
// deploy. Malformed values fall back to the default rather than disabling
// the control — the same posture as lib/config/billAmountLimits.ts.

function readMonths(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * How long an assessment stays usable. Past this, a new plan request
 * triggers re-assessment BEFORE approval — it is not a decline.
 *
 * Six months because `Bureau_Expenses` is a snapshot that cannot include
 * obligations taken on after sign-up, and BNPL competitors in particular
 * mostly do not report on the traditional monthly cadence.
 */
export const STALENESS_MONTHS = readMonths('CREDIT_STALENESS_MONTHS', 6);

/**
 * How long a declined applicant must wait before another assessment.
 * Matched on ID number rather than email or phone, so re-registering with
 * fresh contact details does not buy a fresh billable enquiry.
 */
export const DECLINE_COOLDOWN_MONTHS = readMonths('CREDIT_DECLINE_COOLDOWN_MONTHS', 3);

/**
 * Everything above, as one frozen object, for the digest test and for
 * writing a provenance record alongside an assessment.
 */
export const COEFFICIENTS = {
  version:                    COEFFICIENT_VERSION,
  taxBrackets:                TAX_BRACKETS_2026_27,
  primaryRebateAnnual:        PRIMARY_REBATE_ANNUAL,
  uifRate:                    UIF_RATE,
  uifMonthlyCap:              UIF_MONTHLY_CAP,
  livingExpenseFloorRatio:    LIVING_EXPENSE_FLOOR_RATIO,
  ndiInstalmentRatio:         NDI_INSTALMENT_RATIO,
  mediumConfidenceHaircut:    MEDIUM_CONFIDENCE_HAIRCUT,
  facilityMonths:             FACILITY_MONTHS,
  limitRoundingStep:          LIMIT_ROUNDING_STEP,
  minimumLimit:               MINIMUM_LIMIT,
  bandCeilings:               BAND_CEILINGS,
  scorecardLimitCaps:         SCORECARD_LIMIT_CAPS,
} as const;
