// ─── Step 4: turning an affordability reply into limit inputs ───────────
//
// Pure. Takes a parsed `AffordabilityCallOutcome` plus the band the score
// gate produced, and returns either the inputs the limit calculation needs
// or a pending state.
//
// ─── CONFIDENCE DECIDES WHETHER THE FORMULA RUNS AT ALL ────────────────
//
//   High                       formula runs, no haircut
//   Medium                     formula runs, 0.85 haircut
//   Low                        thin-file treatment
//   "Unable To Determine GMIP" thin-file treatment
//
// The last two are not errors. Experian answered; the answer is that it
// cannot predict this person's income well enough to lend against. That
// resolves to a grant at the thin-file ceiling, which is a different thing
// from both a decline and a technical failure.
//
// An unrecognised confidence string also lands on thin file rather than
// pending. Confidence only ever REDUCES what we will lend, so treating an
// unknown value as the most cautious known value is safe, and it means a
// new string from Experian degrades the limit rather than blocking the
// applicant. It is logged, because the mapping should be updated.
//
// ─── THE THIN-FILE BAND OVERRIDES THE SCORE BAND ───────────────────────
//
// A -209 or -217, or a Low/unable confidence, caps the applicant at the
// thin-file ceiling even when the scorecard put them in Low or Minimum
// risk. The score says how likely they are to default; the affordability
// call says whether we can size a limit at all. Without a usable income
// prediction there is nothing to size against, so the ceiling applies
// regardless of how good the score was.

import type {
  AffordabilityCallOutcome,
  AffordabilityData,
} from '@/lib/experian/affordabilityClient';
import { predictedGross, type GmipPrediction } from './limit';
import type { ScorecardBand } from './coefficients';

/** Why no usable income prediction was available. */
export type ThinFileReason =
  | 'no_gmip'
  | 'no_bureau_record'
  | 'low_confidence'
  | 'unable_to_determine'
  | 'unknown_confidence';

export type AffordabilityResolution =
  | {
      kind: 'ready';
      /** The band the limit calculation should use — possibly downgraded. */
      band: ScorecardBand;
      /** Null on every thin-file route. */
      prediction: GmipPrediction | null;
      /** Why the prediction is null, for the assessment log. */
      thinFileReason: ThinFileReason | null;
      /** The parsed payload, when there was one. Kept for the log. */
      data: AffordabilityData | null;
    }
  | { kind: 'pending'; detail: string; alert: boolean };

function thinFile(
  reason: ThinFileReason,
  data: AffordabilityData | null,
): AffordabilityResolution {
  return { kind: 'ready', band: 'thin_file', prediction: null, thinFileReason: reason, data };
}

/**
 * Resolve an affordability reply against the band the score gate produced.
 */
export function resolveAffordability(
  outcome: AffordabilityCallOutcome,
  scoreBand: ScorecardBand,
): AffordabilityResolution {
  if (outcome.kind === 'unavailable') {
    return { kind: 'pending', detail: outcome.detail, alert: false };
  }

  if (outcome.kind === 'error_code') {
    if (outcome.disposition === 'thin_file') {
      return thinFile(outcome.code === '-217' ? 'no_bureau_record' : 'no_gmip', null);
    }
    return {
      kind: 'pending',
      detail: `${outcome.code}: ${outcome.meaning}`,
      alert: outcome.disposition === 'alert',
    };
  }

  const data = outcome.data;
  const confidence = (data.gmipConfidenceLevel ?? '').trim();

  if (confidence === 'Low')                      return thinFile('low_confidence', data);
  if (confidence === 'Unable To Determine GMIP') return thinFile('unable_to_determine', data);

  if (confidence !== 'High' && confidence !== 'Medium') {
    console.warn('[affordability] unrecognised GMIP_Confidence_Level — treating as thin file', {
      confidence,
    });
    return thinFile('unknown_confidence', data);
  }

  // High or Medium, but the prediction itself has to be usable.
  if (data.gmipValue === null || data.gmipValue <= 0) {
    return thinFile('unable_to_determine', data);
  }

  // ── Missing expense figures ──────────────────────────────────────────
  //
  // Treated as zero rather than as a reason to refuse. A consumer with no
  // reported credit legitimately has no bureau expenses, and a blank field
  // is how that arrives. The protection against reading an absent figure
  // as "nothing to pay" is the living-expense floor in the limit function:
  // 25% of net is deducted whatever Experian says, so net is never treated
  // as fully disposable.
  const prediction: GmipPrediction = {
    gross:              predictedGross(data.gmipValue),
    confidence,
    bureauExpenses:     data.bureauExpenses ?? 0,
    calcLivingExpenses: data.calcLivingExpenses ?? 0,
  };

  return { kind: 'ready', band: scoreBand, prediction, thinFileReason: null, data };
}
