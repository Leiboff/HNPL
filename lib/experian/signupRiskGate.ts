import type { Assessment } from './assessAtSignup';
import { BAND_LABEL, type RiskBand } from './scores';

// ─── The signup risk gate ──────────────────────────────────────────────
//
// "May this applicant continue, given what the bureau says about them."
// A proceed/stop decision on the BAND, taken at the identity step, before
// any other vendor is paid.
//
// ─── WHY THIS IS SEPARATE FROM THE EXPOSURE TABLE ─────────────────────
//
// These are two different questions and only one of them is answerable
// today:
//
//   "Is this person too risky to onboard?"     ← a BAND comparison. Needs
//                                                no calibration. This file.
//   "How much credit may they have?"           ← needs an exposure figure
//                                                per scorecard per band,
//                                                and the rule that turns
//                                                exposure into an allowance.
//                                                Neither exists. See
//                                                affordabilityPolicy.ts.
//
// So this gate reads `assessment.band`, NOT `assessment.decision`. That
// distinction is load-bearing: with the shipped (uncalibrated) exposure
// table, a MINIMUM-RISK band-5 file comes back as `referred` — because
// there is no exposure configured for it, not because there is anything
// wrong with the applicant. Gating on `decision` would refuse everybody,
// including the best files on the book.
//
// ─── THE POLICY ───────────────────────────────────────────────────────
//
// Bands are: 1 very high risk · 2 high · 3 average · 4 low · 5 minimum.
//
//   A scored primary card (SU, SS)  →  proceed at band 3 or better.
//
//   A THIN FILE that fell back to Sigma Transcend (STS)  →  proceed only
//   at band 4 or better, and the applicant is then treated as AVERAGE
//   risk (band 3) regardless of whether STS said 4 or 5.
//
// The thin-file bar is deliberately one band higher than the primary bar,
// and the reward is deliberately capped at average. STS is the thin-file
// scorecard: it is scoring somebody the bureau knows little about, over a
// much tighter spread (bands 2 and 3 are five and six points wide against
// fourteen each on SU). A "minimum risk" verdict on four months of history
// is not the same evidence as a minimum-risk verdict on ten years of it, so
// it buys entry to the product and nothing more.
//
//   An ANSWER with no usable band  →  refuse. A thin file with no STS card
//   beside it, an unrecognised scorecard, an empty result set, an identity
//   flag: the bureau replied and what it said is not evidence of average
//   risk, and on a gate the absence of evidence has to mean no.
//
//   NO ANSWER AT ALL  →  `unavailable`. Also does not proceed — no score,
//   no onboarding — but it is NOT a refusal and must never be recorded
//   against the applicant as one. An outage is our problem, not a fact about
//   them, and the caller says so: "try again later", not a rejection. See
//   SignupRiskOutcome below — that distinction is the reason the return type
//   is not a boolean.
//
// ─── WHAT THIS DOES NOT DECIDE ────────────────────────────────────────
//
// Nothing about money. A `proceed` here is permission to CONTINUE
// ONBOARDING — it is not a credit limit, not an approval, and not an
// affordability assessment. The applicant still reaches the credit-check
// step with no limit, because the allowance rule does not exist.
//
// It also does not decide what the applicant is TOLD. Reason codes are not
// adverse-action reasons and must never be rendered; the caller answers
// with fixed copy. See the note in lib/onboarding/actions.ts.

/** Minimum band on a primary scorecard. 3 = average risk. */
export const MIN_BAND_PRIMARY: RiskBand = 3;

/**
 * Minimum band on the thin-file scorecard. 4 = low risk.
 *
 * One band stricter than the primary bar, on purpose — see the header.
 */
export const MIN_BAND_THIN_FILE: RiskBand = 4;

/**
 * The band a successful thin-file applicant is recorded at, whatever STS
 * actually said. Caps the credit a short history can earn.
 */
export const THIN_FILE_EFFECTIVE_BAND: RiskBand = 3;

/**
 * Sigma Transcend — the thin-file scorecard, and the only one pVersion 4.0
 * falls back to. Named rather than inlined because the fallback list
 * (SCORECARD_PREFERENCE) and this rule have to move together: adding a
 * second thin-file card to one without the other would score it on the
 * primary bar.
 */
export const THIN_FILE_SCORECARD = 'STS';

/**
 * Three outcomes, and the third one is why this is not a boolean.
 *
 *   pass         the bureau scored them at or above the bar.
 *   refuse       the bureau answered, and the answer was against them.
 *   unavailable  we did not get an answer — an outage, a config fault, a
 *                timeout. NOT a verdict about the applicant.
 *
 * NONE OF THEM PROCEEDS EXCEPT `pass`. No score, no onboarding: an applicant
 * we could not assess does not continue to the identity vendors. Product
 * decision, taken explicitly — the alternative (letting an unassessed
 * applicant through to finish onboarding with no credit) was considered and
 * rejected, because it spends money at DHA and Didit on someone we have no
 * risk opinion about.
 *
 * `unavailable` nonetheless stays a SEPARATE outcome from `refuse`, and the
 * distinction is not cosmetic:
 *
 *   • It is not a decision about the applicant, so it must never be recorded
 *     against them as a decline. Nothing here is their fault.
 *   • The caller answers it with different copy — "try again later", not a
 *     refusal — because it is a transient state and they should come back.
 *
 * So: same door, different sign on it, and only one of the two is a fact
 * about the person.
 */
export type SignupRiskOutcome = 'pass' | 'refuse' | 'unavailable';

export type SignupRiskDecision = {
  outcome: SignupRiskOutcome;
  /**
   * May the applicant continue to the identity vendors?
   *
   * Exactly `outcome === 'pass'`. Kept as its own field because every call
   * site asks this question and none of them should have to remember which
   * of the three outcomes is the permissive one.
   */
  proceed: boolean;
  /** The band this applicant is recorded at. Null unless the outcome is `pass`. */
  effectiveBand: RiskBand | null;
  /** The scorecard the decision came from, when there was one. */
  scorecard: string | null;
  /** True when the decision came off the thin-file fallback. */
  thinFileFallback: boolean;
  /**
   * Machine-readable, for the enquiry log and POPIA §71. NEVER rendered to
   * an applicant.
   */
  reason: string;
};

const refuse = (reason: string, scorecard: string | null = null): SignupRiskDecision => ({
  outcome: 'refuse', proceed: false, effectiveBand: null, scorecard, thinFileFallback: false, reason,
});

const unavailable = (reason: string): SignupRiskDecision => ({
  outcome: 'unavailable', proceed: false, effectiveBand: null, scorecard: null,
  thinFileFallback: false, reason,
});

/**
 * Decide whether an applicant may continue, from a completed bureau
 * assessment.
 *
 * Pure — no I/O. Takes the Assessment the caller already has.
 */
export function signupRiskGate(assessment: Assessment): SignupRiskDecision {
  // 1. A decision ABOUT THE APPLICANT that went against them: an
  //    identity-level flag (deceased, sequestrated, debt review, fraud), or
  //    a band whose exposure is calibrated to zero. Never proceeds,
  //    whatever the band says.
  if (assessment.decision === 'declined') {
    return refuse('bureau_declined', assessment.scorecard);
  }

  // 2. We could not get an answer: transport failure, config fault, or an
  //    error code about OUR request rather than about them. Never a pass —
  //    no band is recorded and no credit follows — but not a refusal
  //    either. See SignupRiskOutcome for why those are different.
  if (assessment.decision === 'error') {
    return unavailable('bureau_unavailable');
  }

  // 3. Nothing scoreable came back — a thin file with no STS card beside
  //    it, an unrecognised scorecard, an empty result set. This IS an
  //    answer: the bureau replied and had nothing to score. Not evidence of
  //    average risk, so it refuses.
  if (assessment.band === null || assessment.scorecard === null) {
    return refuse('no_usable_band', assessment.scorecard);
  }

  const band = assessment.band;
  const scorecard = assessment.scorecard;

  // 4. The thin-file fallback, on its own stricter bar and its own cap.
  if (scorecard.toUpperCase() === THIN_FILE_SCORECARD) {
    if (band < MIN_BAND_THIN_FILE) {
      return refuse(`thin_file_band_${band}_below_${MIN_BAND_THIN_FILE}`, scorecard);
    }
    return {
      outcome: 'pass',
      proceed: true,
      effectiveBand: THIN_FILE_EFFECTIVE_BAND,
      scorecard,
      thinFileFallback: true,
      reason: `thin_file_band_${band}_as_${BAND_LABEL[THIN_FILE_EFFECTIVE_BAND]}`,
    };
  }

  // 5. A scored primary card.
  if (band < MIN_BAND_PRIMARY) {
    return refuse(`band_${band}_below_${MIN_BAND_PRIMARY}`, scorecard);
  }
  return {
    outcome: 'pass',
    proceed: true,
    effectiveBand: band,
    scorecard,
    thinFileFallback: false,
    reason: `band_${band}_${BAND_LABEL[band]}`,
  };
}
