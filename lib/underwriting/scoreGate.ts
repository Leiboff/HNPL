// ─── The score gate. Pure policy over a parsed bureau reply ─────────────
//
// Step 1 of the pipeline, and the reason the pipeline is ordered the way
// it is: this runs before the paid identity check and before the paid
// affordability enquiry, so a refusal costs one call instead of three.
//
// Pure — takes a parsed `ScoreCallOutcome`, returns a decision. No I/O, so
// the whole decision table is unit-testable without a network.
//
// ─── FOUR OUTCOMES, AND THE DIFFERENCE BETWEEN TWO OF THEM ─────────────
//
//   pass       proceed to identity
//   thin_file  proceed, but the limit is capped at the thin-file ceiling
//   decline    a substantive refusal. Enters the cooldown.
//   pending    we could not get an answer. NOT a refusal, does NOT enter
//              the cooldown, and the patient must never be told they were
//              refused.
//
// That last distinction is the one most likely to be flattened by a later
// refactor, because both `decline` and `pending` stop the flow. They are
// different rows in the assessment log, different copy, and only one of
// them locks the applicant out for three months. A technical failure that
// silently became a decline would refuse people we never assessed.
//
// ─── CARD PREFERENCE AND THE TRANSCEND FALLBACK ────────────────────────
//
// One call returns several scorecards. We walk the configured preference
// order and take the first card that gives a usable answer:
//
//   • a real score          → band it, and pass or decline on the band
//   • a hard sentinel       → decline immediately; -2/-3/-4/-6 are facts
//                             about the person, not about the card, so
//                             there is nothing to fall back to
//   • a bureau dispute      → pending for review, same reasoning
//   • a thin-file signal    → try the NEXT card. This is the fallback:
//                             Sigma Transcend exists precisely to score
//                             applicants the traditional cards cannot.
//   • a card we cannot read → note it and try the next
//
// Exhausting the list without a real score means thin-file treatment if
// any card said thin file, and pending-plus-alert otherwise — including
// when the branch returned only cards outside our preference list, which
// is a configuration error we want to hear about rather than price around.

import { classifyScore, bandDeclines, type BandCutoffs, type ScoreClassification } from '@/lib/experian/bands';
import type { ScoreCallOutcome, ScoreResultRow } from '@/lib/experian/scoreClient';
import type { ScorecardBand } from './coefficients';

/** Why an applicant was refused at the score gate. */
export type ScoreDeclineReason =
  | 'band'
  | 'deceased'
  | 'sequestrated'
  | 'debt_review'
  | 'fraud';

export type ScoreGateDecision =
  | {
      kind: 'pass';
      band: Exclude<ScorecardBand, 'thin_file'>;
      score: number;
      resultType: string;
      /** Every card the bureau returned, for the assessment log. */
      results: ScoreResultRow[];
    }
  | {
      kind: 'thin_file';
      detail: 'warning_code' | 'legacy_range' | 'no_bureau_record';
      /** The card that reported it, when there was one. */
      resultType: string | null;
      score: number | null;
      results: ScoreResultRow[];
    }
  | {
      kind: 'decline';
      reason: ScoreDeclineReason;
      /** Present only for a band decline. */
      band: ScorecardBand | null;
      score: number | null;
      resultType: string | null;
      results: ScoreResultRow[];
    }
  | {
      kind: 'pending';
      detail: string;
      /** True when this needs a human to look at it, not just a retry. */
      alert: boolean;
      /** True for a bureau dispute — a review queue, not a retry. */
      review: boolean;
      results: ScoreResultRow[];
    };

/** Map a hard sentinel classification onto a decline reason. */
function sentinelReason(detail: string): ScoreDeclineReason {
  switch (detail) {
    case 'deceased':      return 'deceased';
    case 'sequestrated':  return 'sequestrated';
    case 'debt_review':   return 'debt_review';
    default:              return 'fraud';
  }
}

/**
 * Decide the score gate.
 *
 * `preference` is the ordered list of scorecards to consult; `cards` is
 * the band table for the family `pVersion` selected. Both are passed in
 * rather than read from env, so this stays pure and the tests can drive
 * every combination.
 */
export function decideScoreGate(
  outcome: ScoreCallOutcome,
  preference: readonly string[],
  cards: Readonly<Record<string, BandCutoffs>>,
): ScoreGateDecision {
  // ── Transport failure. Never a decline. ──────────────────────────────
  if (outcome.kind === 'unavailable') {
    return { kind: 'pending', detail: outcome.detail, alert: false, review: false, results: [] };
  }

  // ── A coded error from the bureau. ───────────────────────────────────
  if (outcome.kind === 'error_code') {
    if (outcome.disposition === 'thin_file') {
      // -115: answered, no record. A grant at the thin-file ceiling, which
      // is a substantive outcome rather than a failure.
      return {
        kind: 'thin_file',
        detail: 'no_bureau_record',
        resultType: null,
        score: null,
        results: [],
      };
    }
    return {
      kind: 'pending',
      detail: `${outcome.code}: ${outcome.meaning}`,
      alert: outcome.disposition === 'alert',
      review: false,
      results: [],
    };
  }

  // ── Results. Walk the preference order. ──────────────────────────────
  const results = outcome.results;
  const byCard = new Map(results.map((r) => [r.resultType.toUpperCase(), r]));

  let sawThinFile: ScoreClassification | null = null;
  let sawUnusable: ScoreClassification | null = null;

  for (const card of preference) {
    const row = byCard.get(card.toUpperCase());
    if (row === undefined) continue;

    const classified = classifyScore(row.resultType, row.score, cards);

    switch (classified.kind) {
      case 'band':
        return bandDeclines(classified.band)
          ? {
              kind: 'decline',
              reason: 'band',
              band: classified.band,
              score: classified.score,
              resultType: classified.resultType,
              results,
            }
          : {
              kind: 'pass',
              band: classified.band,
              score: classified.score,
              resultType: classified.resultType,
              results,
            };

      case 'decline':
        // A fact about the person. No fallback card can overturn it.
        return {
          kind: 'decline',
          reason: sentinelReason(classified.detail),
          band: null,
          score: classified.score,
          resultType: classified.resultType,
          results,
        };

      case 'review':
        return {
          kind: 'pending',
          detail: `bureau dispute on ${classified.resultType}`,
          alert: false,
          review: true,
          results,
        };

      case 'thin_file':
        // Remember it and try the next card. This is the fallback path.
        sawThinFile ??= classified;
        break;

      case 'unusable':
        sawUnusable ??= classified;
        break;
    }
  }

  // ── Preference exhausted with no real score. ─────────────────────────
  if (sawThinFile !== null && sawThinFile.kind === 'thin_file') {
    return {
      kind: 'thin_file',
      detail: sawThinFile.detail,
      resultType: sawThinFile.resultType,
      score: sawThinFile.score,
      results,
    };
  }

  if (sawUnusable !== null && sawUnusable.kind === 'unusable') {
    return {
      kind: 'pending',
      detail: `unusable score: ${sawUnusable.detail} on ${sawUnusable.resultType}`,
      alert: true,
      review: false,
      results,
    };
  }

  // Nothing in the preference list came back at all. Almost certainly a
  // branch/config mismatch — the cards we asked for are not switched on.
  return {
    kind: 'pending',
    detail: `no preferred scorecard in reply (wanted ${preference.join(',')}, `
      + `got ${results.map((r) => r.resultType).join(',') || 'nothing'})`,
    alert: true,
    review: false,
    results,
  };
}

/** True when this decision permits the flow to continue to identity. */
export function scoreGatePasses(decision: ScoreGateDecision): boolean {
  return decision.kind === 'pass' || decision.kind === 'thin_file';
}

/**
 * The band a passing decision implies, for the limit calculation.
 * Thin-file decisions carry the thin-file band regardless of any score.
 */
export function bandFromDecision(decision: ScoreGateDecision): ScorecardBand | null {
  if (decision.kind === 'pass')      return decision.band;
  if (decision.kind === 'thin_file') return 'thin_file';
  return null;
}

/**
 * A score decision, flattened for storage between pipeline stages.
 *
 * The assessment happens in two requests — the score at the identity step
 * and the pricing at the affordability step — and `credit_assessments` is
 * append-only, so the second cannot amend the first. This travels on the
 * profile so the ONE row written at the end carries both halves.
 */
export type ScoreSnapshot = {
  value: number | null;
  resultType: string | null;
  band: ScorecardBand | null;
  results: ScoreResultRow[];
};

export function scoreSnapshotOf(decision: ScoreGateDecision): ScoreSnapshot | null {
  if (decision.kind === 'pass') {
    return {
      value: decision.score, resultType: decision.resultType,
      band: decision.band, results: decision.results,
    };
  }
  if (decision.kind === 'thin_file') {
    return {
      value: decision.score, resultType: decision.resultType,
      band: 'thin_file', results: decision.results,
    };
  }
  // A terminal decision writes its own assessment row; there is nothing to
  // carry forward.
  return null;
}
