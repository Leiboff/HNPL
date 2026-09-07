/**
 * Score bands, warning codes and the hard gate.
 *
 * Two rules this file exists to enforce:
 *   1. A NEGATIVE score is not a low score. -2 means deceased. Any code that does
 *      `score >= threshold` on a raw value will silently treat "deceased" as "declined
 *      because risky", which is both a wrong decision and a wrong adverse-action reason.
 *   2. Bands are PER SCORECARD. SU minimum-risk starts at 668, SRC at 625. Sharing one
 *      band table across resultTypes silently mis-scales every decision.
 */

import type { ScoreResult } from './client';

// ── Warning codes ─────────────────────────────────────────────────────────────
// §5.5. These arrive in the `score` field itself, per result, in place of a score.

export type WarningAction = 'hard_decline' | 'manual_review' | 'thin_file';

export interface SigmaWarning {
  value: number;
  label: string;
  action: WarningAction;
}

export const SIGMA_WARNINGS: Record<number, SigmaWarning> = {
  [-1]: { value: -1, label: 'Thin file', action: 'thin_file' },
  [-2]: { value: -2, label: 'Deceased', action: 'hard_decline' },
  [-3]: { value: -3, label: 'Sequestrated', action: 'hard_decline' },
  // Under debt review a consumer may not incur further credit until clearance
  // (NCA s88(3)). This is a legal bar, not a risk judgement.
  [-4]: { value: -4, label: 'Under/Requested Debt Review', action: 'hard_decline' },
  [-5]: { value: -5, label: 'Bureau Dispute', action: 'manual_review' },
  [-6]: { value: -6, label: 'Fraud', action: 'hard_decline' },
};

/**
 * The two score families signal "no usable score" in DIFFERENT and incompatible ways:
 *
 *   Sigma (SS/SU/SBF/SRC/SCM/STS) — a NEGATIVE value, per §5.5. -1 thin file, -2 deceased...
 *   Legacy (CPA/NLR/CT/CU)        — a POSITIVE value BELOW the credit-active floor. §4.1:
 *                                   "A score ranges from 480 to 710 for credit active
 *                                   consumers... a thin file, the score will be between 1 and 4."
 *
 * Miss the second and an NLR thin file of 3 reads as a real score, lands in band 1, and
 * declines the consumer for risk when the truth is that Experian holds no data on them.
 * Wrong decision, and the wrong reason on the POPIA §71 record.
 */
export const CREDIT_ACTIVE_FLOOR = 480;

const SIGMA_SCORECARDS = new Set(['SS', 'SU', 'SBF', 'SRC', 'SCM', 'STS']);

export function isSigmaScorecard(resultType: string): boolean {
  return SIGMA_SCORECARDS.has(resultType.toUpperCase());
}

export function warningFor(result: ScoreResult): SigmaWarning | null {
  if (result.score === null) return null;

  if (result.score < 0) {
    return SIGMA_WARNINGS[result.score] ?? { value: result.score, label: 'Unknown warning code', action: 'manual_review' };
  }

  if (!isSigmaScorecard(result.resultType) && result.score < CREDIT_ACTIVE_FLOOR) {
    return { value: result.score, label: `Thin file (legacy ${result.score} of 1-4)`, action: 'thin_file' };
  }

  return null;
}

/** A score we can actually band and lend against. Use this, never a bare `score >= 0`. */
export function isRealScore(result: ScoreResult): boolean {
  return result.score !== null && warningFor(result) === null;
}

// ── Bands ─────────────────────────────────────────────────────────────────────
// Inclusive upper bounds per band, from §4.1, §4.2 and §5.3. Bands are stated with
// mixed notation in the spec ("< 599" vs "<= 594"); normalised here to integers.

export type RiskBand = 1 | 2 | 3 | 4 | 5;
export const BAND_LABEL: Record<RiskBand, string> = {
  1: 'very_high_risk',
  2: 'high_risk',
  3: 'average_risk',
  4: 'low_risk',
  5: 'minimum_risk',
};

/** Upper bound of bands 1–4; band 5 is everything above. */
const BAND_BOUNDS: Record<string, [number, number, number, number]> = {
  SS: [598, 615, 633, 657], // Sigma Standard
  SU: [623, 637, 651, 667], // Sigma Unsecured Credit
  SBF: [617, 637, 658, 682], // Sigma Banking Finance
  SRC: [583, 594, 606, 624], // Sigma Retail Credit
  SCM: [628, 658, 680, 697], // Sigma Customer Management
  STS: [597, 602, 608, 621], // Sigma Transcend (thin-file)
  CT: [594, 610, 628, 659], // Compuscore V3
  CU: [621, 634, 651, 672], // Compuscore V3 Unsecured
  CPA: [605, 621, 641, 667],
  NLR: [603, 618, 632, 653],
};

export function bandFor(resultType: string, score: number): RiskBand | null {
  const bounds = BAND_BOUNDS[resultType.toUpperCase()];
  if (!bounds || score < 0) return null;
  // Legacy thin-file range (1-4) is not a risk score, so it has no band.
  if (!isSigmaScorecard(resultType) && score < CREDIT_ACTIVE_FLOOR) return null;
  for (let i = 0; i < bounds.length; i++) {
    if (score <= bounds[i]) return (i + 1) as RiskBand;
  }
  return 5;
}

export function isKnownScorecard(resultType: string): boolean {
  return resultType.toUpperCase() in BAND_BOUNDS;
}

// ── The gate ──────────────────────────────────────────────────────────────────

export interface GateOutcome {
  decision: 'hard_decline' | 'manual_review' | 'thin_file' | 'proceed';
  /** Machine codes for the §71 adverse-action record. Never rendered raw to a patient. */
  codes: string[];
  detail: string;
}

/**
 * Identity-level warnings (deceased / sequestrated / debt review / fraud) are facts about
 * the person, so one on ANY returned scorecard decides the whole application. Thin file is
 * NOT: the Sigma example in §8 returns SCM = -1 alongside SU = 618 and SS = 634, because
 * customer-management has nothing to score on a non-customer. Thin file only counts when
 * EVERY scorecard came back thin.
 */
export function gate(results: ScoreResult[]): GateOutcome {
  if (results.length === 0) {
    return { decision: 'manual_review', codes: ['NO_RESULTS'], detail: 'completed call returned no scorecards' };
  }

  const warnings = results.map((r) => ({ r, w: warningFor(r) }));

  const blocking = warnings.filter((x) => x.w?.action === 'hard_decline');
  if (blocking.length > 0) {
    return {
      decision: 'hard_decline',
      codes: blocking.map((x) => `WARN${x.w!.value}`),
      detail: blocking.map((x) => `${x.r.resultType}: ${x.w!.label}`).join('; '),
    };
  }

  const review = warnings.filter((x) => x.w?.action === 'manual_review');
  if (review.length > 0) {
    return {
      decision: 'manual_review',
      codes: review.map((x) => `WARN${x.w!.value}`),
      detail: review.map((x) => `${x.r.resultType}: ${x.w!.label}`).join('; '),
    };
  }

  const scored = results.filter(isRealScore);
  if (scored.length === 0) {
    const codes = warnings.map((x) => (x.w ? `WARN${x.w.value}` : 'NO_SCORE'));
    return { decision: 'thin_file', codes, detail: 'every scorecard returned thin file / no usable score' };
  }

  return { decision: 'proceed', codes: [], detail: `${scored.length} scorecard(s) scored` };
}

/** Pick a scorecard by resultType. Never index into results[] — order is not guaranteed. */
export function selectScorecard(results: ScoreResult[], resultType: string): ScoreResult | null {
  const want = resultType.toUpperCase();
  return results.find((r) => r.resultType === want && isRealScore(r)) ?? null;
}
