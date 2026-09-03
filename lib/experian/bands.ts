// ─── Score → band, per scorecard. The module that decides declines ──────
//
// Pure. This is the highest-consequence lookup in the integration, so it
// is deliberately boring: explicit tables, no arithmetic on cutoffs, no
// default branch that could quietly approve.
//
// ─── WHY THE TABLE IS KEYED ON THE SCORECARD, NOT JUST THE SCORE ───────
//
// The same number means different things on different cards. A score of
// 620, live, off one enquiry:
//
//     Sigma Transcend (STS)          620 → Low Risk        (609–621)
//     Sigma Standard (SS)            620 → Average Risk    (616–633)
//     Sigma Unsecured Credit (SU)    620 → Very High Risk  (< 624)
//
// Decline to R10,000 across three cards, on one integer. A band map keyed
// on the score alone is not a simplification of this table, it is a
// mispricing — so `bandFor` requires the `resultType` and returns an
// explicit "unknown scorecard" rather than guessing.
//
// ─── WHY NEGATIVE SCORES ARE CHECKED FIRST ─────────────────────────────
//
// Spec §5.5 gives six negative sentinel values, and only ONE of them is a
// thin file:
//
//     -1  thin file            →  thin-file ceiling
//     -2  deceased             →  decline
//     -3  sequestrated         →  decline
//     -4  under/requested debt review  →  decline (NCA prohibition)
//     -5  bureau dispute       →  manual review, not a verdict
//     -6  fraud                →  decline
//
// Two failure modes this ordering prevents. Treating every negative as a
// thin file extends credit to a deceased consumer, a fraud flag, and — the
// one that is not merely unwise but unlawful — a consumer under debt
// review. Comparing them against the band cutoffs instead makes all six
// "Very High Risk" and DECLINES the thin files, which is the opposite of
// the intended treatment for the largest single segment of this book.
//
// So: sentinels resolve before any range comparison, and each maps to its
// own outcome.
//
// ─── AND WHY 1–4 IS ALSO A THIN FILE ───────────────────────────────────
//
// Spec §4.1: "A score ranges from 480 to 710 for credit active consumers.
// In the event that a consumer does not have sufficient data, a thin file,
// the score will be between 1 and 4." That is the legacy CPA/NLR/
// Compuscore convention; Sigma signals the same condition with -1. Both
// are handled, because `pVersion` selects the family and we should not
// break if it is ever changed.

import type { ScorecardBand } from '@/lib/underwriting/coefficients';

/**
 * Lower bounds, ascending. A score below `high` is Very High Risk; at or
 * above `minimum` it is Minimum Risk. Every table below is contiguous in
 * the spec, so four bounds describe five bands with no gaps.
 */
export type BandCutoffs = {
  high: number;
  average: number;
  low: number;
  minimum: number;
};

/**
 * Sigma suite — `pVersion` 4.0. Spec §5.3.
 *
 * Note this whole family is UNDOCUMENTED in the v2.1 integration PDF
 * (© 2021, predating the Sigma rollout); the cutoffs come from §5.3 of the
 * later revision and the card codes from §5.2. Verified against a live
 * UAT call that returned SU and STS.
 */
export const SIGMA_BANDS: Readonly<Record<string, BandCutoffs>> = {
  /** Sigma Standard */
  SS:  { high: 599, average: 616, low: 634, minimum: 658 },
  /** Sigma Unsecured Credit */
  SU:  { high: 624, average: 638, low: 652, minimum: 668 },
  /** Sigma Banking Finance */
  SBF: { high: 618, average: 638, low: 659, minimum: 683 },
  /** Sigma Retail Credit */
  SRC: { high: 584, average: 595, low: 607, minimum: 625 },
  /** Sigma Customer Management */
  SCM: { high: 629, average: 659, low: 681, minimum: 698 },
  /** Sigma Transcend — the thin-file / non-traditional card. */
  STS: { high: 598, average: 603, low: 609, minimum: 622 },
} as const;

/** CPA & NLR — `pVersion` 1.0. Spec §4.1. */
export const LEGACY_BANDS: Readonly<Record<string, BandCutoffs>> = {
  CPA: { high: 606, average: 622, low: 642, minimum: 668 },
  NLR: { high: 604, average: 619, low: 633, minimum: 654 },
} as const;

/** Compuscore V3 — `pVersion` 2.0. Spec §4.2. */
export const COMPUSCORE_BANDS: Readonly<Record<string, BandCutoffs>> = {
  /** Compuscore V3, traditional markets */
  CT: { high: 595, average: 611, low: 629, minimum: 660 },
  /** Compuscore V3 Unsecured, micro-finance */
  CU: { high: 622, average: 635, low: 652, minimum: 673 },
} as const;

/** Every card we can band, across all families. */
export const ALL_BANDS: Readonly<Record<string, BandCutoffs>> = {
  ...SIGMA_BANDS,
  ...LEGACY_BANDS,
  ...COMPUSCORE_BANDS,
} as const;

// ── Negative sentinels (§5.5) ──────────────────────────────────────────

export type SentinelOutcome =
  | { kind: 'thin_file'; detail: 'warning_code' }
  | { kind: 'decline';   detail: 'deceased' | 'sequestrated' | 'debt_review' | 'fraud' }
  | { kind: 'review';    detail: 'bureau_dispute' };

export const SCORE_SENTINELS: Readonly<Record<number, SentinelOutcome>> = {
  [-1]: { kind: 'thin_file', detail: 'warning_code' },
  [-2]: { kind: 'decline',   detail: 'deceased' },
  [-3]: { kind: 'decline',   detail: 'sequestrated' },
  [-4]: { kind: 'decline',   detail: 'debt_review' },
  [-5]: { kind: 'review',    detail: 'bureau_dispute' },
  [-6]: { kind: 'decline',   detail: 'fraud' },
} as const;

/** Legacy thin-file signal: a score of 1–4 inclusive (§4.1). */
const LEGACY_THIN_FILE_MAX = 4;

/**
 * Plausible range for a real banded score. The spec quotes 480–710 for
 * credit-active consumers; this is deliberately wider so a card whose
 * range shifts slightly does not start failing, while still catching a 0,
 * a 5-digit value, or a parse that produced nonsense.
 */
const MIN_PLAUSIBLE_SCORE = 300;
const MAX_PLAUSIBLE_SCORE = 999;

export type ScoreClassification =
  /** A real score on a known card. */
  | { kind: 'band'; band: Exclude<ScorecardBand, 'thin_file'>; score: number; resultType: string }
  /** Answered, but with no usable history. A grant at the thin-file ceiling. */
  | { kind: 'thin_file'; score: number; resultType: string; detail: 'warning_code' | 'legacy_range' }
  /** A substantive refusal. */
  | { kind: 'decline'; score: number; resultType: string; detail: 'deceased' | 'sequestrated' | 'debt_review' | 'fraud' }
  /** Cannot be assessed automatically. Resolves to pending + review, never a decline. */
  | { kind: 'review'; score: number; resultType: string; detail: 'bureau_dispute' }
  /** We do not understand the answer. Resolves to pending + alert, never a decline. */
  | { kind: 'unusable'; score: number; resultType: string; detail: 'unknown_scorecard' | 'out_of_range' };

/**
 * Band a raw score for a given scorecard.
 *
 * `rawScore` is the string Experian sends (`"620"`, `"-1"`); parsing is
 * done here so a non-numeric value lands in `unusable` rather than
 * becoming NaN and silently comparing false against every cutoff.
 *
 * `cards` defaults to every known card. Pass a narrower table to reject
 * cards outside the family `pVersion` selected.
 */
export function classifyScore(
  resultType: string,
  rawScore: string | number,
  cards: Readonly<Record<string, BandCutoffs>> = ALL_BANDS,
): ScoreClassification {
  const score = typeof rawScore === 'number' ? rawScore : Number(String(rawScore).trim());

  if (!Number.isFinite(score)) {
    return { kind: 'unusable', score: NaN, resultType, detail: 'out_of_range' };
  }

  // ── 1. Sentinels, BEFORE any range comparison. See the header. ───────
  if (score <= 0) {
    const sentinel = SCORE_SENTINELS[score];
    if (sentinel === undefined) {
      // A negative value we have no definition for. Not a decline — we do
      // not refuse an applicant on a code we cannot read.
      return { kind: 'unusable', score, resultType, detail: 'out_of_range' };
    }
    if (sentinel.kind === 'thin_file') {
      return { kind: 'thin_file', score, resultType, detail: 'warning_code' };
    }
    if (sentinel.kind === 'review') {
      return { kind: 'review', score, resultType, detail: 'bureau_dispute' };
    }
    return { kind: 'decline', score, resultType, detail: sentinel.detail };
  }

  // ── 2. Legacy thin-file range (§4.1). ────────────────────────────────
  if (score <= LEGACY_THIN_FILE_MAX) {
    return { kind: 'thin_file', score, resultType, detail: 'legacy_range' };
  }

  // ── 3. A real score needs a card we know the cutoffs for. ────────────
  const cutoffs = cards[resultType];
  if (cutoffs === undefined) {
    return { kind: 'unusable', score, resultType, detail: 'unknown_scorecard' };
  }

  if (score < MIN_PLAUSIBLE_SCORE || score > MAX_PLAUSIBLE_SCORE) {
    return { kind: 'unusable', score, resultType, detail: 'out_of_range' };
  }

  if (score <  cutoffs.high)    return { kind: 'band', band: 'very_high', score, resultType };
  if (score <  cutoffs.average) return { kind: 'band', band: 'high',      score, resultType };
  if (score <  cutoffs.low)     return { kind: 'band', band: 'average',   score, resultType };
  if (score <  cutoffs.minimum) return { kind: 'band', band: 'low',       score, resultType };
  return { kind: 'band', band: 'minimum', score, resultType };
}

/**
 * Does this band decline the application?
 *
 * The two bands below Average. Experian has no "below average risk" band
 * despite the phrase being in circulation — the ladder is Very High, High,
 * Average, Low, Minimum, and "below average risk" means the two beneath
 * Average, both of which refuse.
 */
export function bandDeclines(band: ScorecardBand): boolean {
  return band === 'high' || band === 'very_high';
}
