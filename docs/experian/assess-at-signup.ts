/**
 * Bureau assessment at sign-up.
 *
 * Order is load-bearing and each step exists to stop the next one being wasted or unlawful:
 *   consent gate → local ID validation → cache/dedupe → attempt row → billable call → decide → persist
 *
 * Wire this behind the existing sign-up server action. It must never be reachable from a
 * client component and never return raw reason descriptions to the browser.
 */

import { getScore, type ExperianConfig, type ExperianOutcome, type ScoreResult } from './client';
import { bandFor, gate, selectScorecard, type RiskBand } from './scores';

// ── Credit policy ─────────────────────────────────────────────────────────────
// These are YOUR numbers, not mine. Left null deliberately so an unconfigured
// deployment fails closed rather than issuing an allowance off a default I invented.
// Exposure, not purchase value — Purchase Allowance = Exposure × 1.5 is applied downstream.

/**
 * Ordered preference. The first scorecard present in the response with a usable score
 * wins. A list rather than a constant because what Experian returns depends on how the
 * branch is provisioned, not on what we ask for: pVersion 2.0 was expected to yield
 * Compuscore V3 (CT/CU) per the spec and actually returned Sigma Standard (SS) alone.
 *
 * If none of these are present the assessment refers rather than guessing — but check
 * the referral rate after any provisioning change, because a scorecard silently
 * disappearing from the response looks exactly like a run of cautious applicants.
 */
export const SCORECARD_PREFERENCE = ['SU', 'SS', 'STS'] as const;

/**
 * Exposure by scorecard AND band — deliberately not band alone.
 *
 * Bands are ordinal labels on separate scorecards, not a shared risk scale: a band 4 on
 * NLR is not the same default probability as a band 4 on SS, and the cards do not even
 * span the same numeric range. Keying on band alone invites porting one card's calibration
 * onto another, which silently mis-prices every applicant.
 *
 * All null except the entry decline. These are YOUR numbers and must be calibrated per
 * card; unconfigured means refer, never issue an allowance off an invented default.
 */
export const RISK_EXPOSURE_CENTS: Record<string, Record<RiskBand, number | null>> = {
  SU: { 1: 0, 2: null, 3: null, 4: null, 5: null },
  SS: { 1: 0, 2: null, 3: null, 4: null, 5: null },
  STS: { 1: 0, 2: null, 3: null, 4: null, 5: null },
  NLR: { 1: 0, 2: null, 3: null, 4: null, 5: null },
  CPA: { 1: 0, 2: null, 3: null, 4: null, 5: null },
};

/** How long a pull stays good. Re-pulling costs money AND adds an enquiry footprint —
 *  "High Number of Recent Enquiries" is reason code 58/59 in this very spec. */
export const CACHE_TTL_DAYS = 45;

export type AssessmentDecision = 'approved' | 'declined' | 'referred' | 'error';

export interface Assessment {
  decision: AssessmentDecision;
  riskExposureCents: number | null;
  scorecard: string | null;
  score: number | null;
  band: RiskBand | null;
  /** Stored for POPIA §71. Not for display. */
  reasonCodes: string[];
  detail: string;
  billed: boolean;
  fromCache: boolean;
}

export interface AssessmentDeps {
  config: ExperianConfig;
  /** Blind index over the SA ID — reuse the existing one, do not mint a second. */
  hashIdNumber: (idNumber: string) => Promise<string>;
  /** True only if this profile has an ACCEPTED terms row covering the bureau clause. */
  hasBureauConsent: (profileId: string) => Promise<boolean>;
  /** SA ID: 13 digits, valid YYMMDD, Luhn checksum, 18+. Reuse lib/validation. */
  validateSaId: (idNumber: string) => { valid: boolean; reason?: string };
  findFreshEnquiry: (idHash: string, ttlDays: number) => Promise<Assessment | null>;
  /** Insert BEFORE the call so a timeout still leaves evidence of a possibly-billed attempt. */
  openAttempt: (row: { profileId: string; idHash: string; pVersion: string }) => Promise<string>;
  closeAttempt: (attemptId: string, row: {
    outcome: ExperianOutcome['kind'];
    errorCode: string | null;
    latencyMs: number;
    billed: boolean;
    results: ScoreResult[] | null;
    rawPayload: string | null;
    assessment: Assessment;
  }) => Promise<void>;
}

export async function assessAtSignup(
  profileId: string,
  idNumber: string,
  deps: AssessmentDeps,
): Promise<Assessment> {
  const fail = (decision: AssessmentDecision, detail: string, billed = false): Assessment => ({
    decision, riskExposureCents: null, scorecard: null, score: null, band: null,
    reasonCodes: [], detail, billed, fromCache: false,
  });

  // 1. Consent. The lawful basis for the enquiry lives in the accepted T&Cs, so this
  //    reads the ACCEPTANCE ROW, not the signup checkbox. (Same shape as the default-fee
  //    gate that turned out to be missing: a rendered checkbox is not a recorded consent.)
  if (!(await deps.hasBureauConsent(profileId))) {
    return fail('error', 'no recorded bureau consent for this profile');
  }

  // 2. Local validation before spending money. -114 is billable.
  const local = deps.validateSaId(idNumber);
  if (!local.valid) return fail('error', `local ID validation failed: ${local.reason ?? 'invalid'}`);

  const idHash = await deps.hashIdNumber(idNumber);

  // 3. Cache. Also the concurrency guard — put a unique index on (id_hash) WHERE
  //    still-fresh so two tabs cannot double-bill the same person.
  const cached = await deps.findFreshEnquiry(idHash, CACHE_TTL_DAYS);
  if (cached) return { ...cached, fromCache: true };

  const attemptId = await deps.openAttempt({ profileId, idHash, pVersion: deps.config.pVersion });
  const outcome = await getScore(idNumber, deps.config);

  const assessment = decide(outcome);
  await deps.closeAttempt(attemptId, {
    outcome: outcome.kind,
    errorCode: 'errorCode' in outcome ? outcome.errorCode : null,
    latencyMs: outcome.latencyMs,
    billed: assessment.billed,
    results: outcome.kind === 'ok' ? outcome.results : null,
    rawPayload: outcome.kind === 'ok' ? outcome.raw : null,
    assessment,
  });

  return assessment;
}

export function decide(outcome: ExperianOutcome): Assessment {
  const base = { riskExposureCents: null, scorecard: null, score: null, band: null, fromCache: false };

  switch (outcome.kind) {
    case 'transport_error':
      // No envelope came back, so we cannot know whether it billed. Recorded as unbilled
      // but the attempt row exists, which is what reconciliation against Experian's
      // invoice actually needs.
      return { ...base, decision: 'error', reasonCodes: [], detail: outcome.reason, billed: false };

    case 'config_error':
    case 'provider_error':
      // Never surfaced to the patient as a decline. Our problem, not theirs.
      return {
        ...base, decision: 'error', reasonCodes: [outcome.errorCode],
        detail: outcome.errorDescription, billed: outcome.kind === 'provider_error',
      };

    case 'input_error':
      return { ...base, decision: 'error', reasonCodes: [outcome.errorCode], detail: outcome.errorDescription, billed: true };

    case 'thin_file':
      // -115: no bureau data at all. Nothing to fail over to — STS needs a file to score.
      return { ...base, decision: 'referred', reasonCodes: ['-115'], detail: 'no bureau data for this ID', billed: true };

    case 'ok': {
      const g = gate(outcome.results);
      if (g.decision === 'hard_decline') {
        return { ...base, decision: 'declined', reasonCodes: g.codes, detail: g.detail, billed: true };
      }
      if (g.decision === 'manual_review') {
        return { ...base, decision: 'referred', reasonCodes: g.codes, detail: g.detail, billed: true };
      }

      // Thin file must be its own outcome, not a fall-through. Confirmed against a real
      // payload (Aug 2026): a thin file returns SU score "-1" with reason MI62 and NO
      // STS card alongside it, even with Transcend provisioned. Letting this drop through
      // to scorecard selection loses the WARN-1 signal and files the decision under
      // NO_USABLE_SCORECARD, which is both wrong for POPIA §71 and indistinguishable from
      // a genuine configuration failure. Route it explicitly and keep the diagnostic reason codes.
      if (g.decision === 'thin_file') {
        const diagnostic = outcome.results.flatMap((r) => r.reasons.map((x) => x.code));
        return {
          ...base,
          decision: 'referred',
          reasonCodes: [...g.codes, ...diagnostic],
          detail: g.detail,
          billed: true,
        };
      }

      let card = null;
      for (const preferred of SCORECARD_PREFERENCE) {
        card = selectScorecard(outcome.results, preferred);
        if (card) break;
      }

      if (!card || card.score === null) {
        return { ...base, decision: 'referred', reasonCodes: ['NO_USABLE_SCORECARD'], detail: g.detail, billed: true };
      }

      const band = bandFor(card.resultType, card.score);
      if (band === null) {
        return {
          ...base, decision: 'referred', reasonCodes: ['UNKNOWN_SCORECARD'],
          detail: `no band table for resultType ${card.resultType}`, billed: true,
        };
      }

      const table = RISK_EXPOSURE_CENTS[card.resultType];
      const exposure = table ? table[band] : null;
      const reasonCodes = card.reasons.map((r) => r.code);

      // Unconfigured card or band → refer. Never issue an allowance off a missing
      // policy value, and never fall back to another card's calibration.
      if (exposure === null) {
        return {
          ...base, decision: 'referred', scorecard: card.resultType, score: card.score, band,
          reasonCodes,
          detail: table ? `no exposure configured for ${card.resultType} band ${band}`
                        : `no exposure table for scorecard ${card.resultType}`,
          billed: true,
        };
      }

      return {
        decision: exposure > 0 ? 'approved' : 'declined',
        riskExposureCents: exposure,
        scorecard: card.resultType,
        score: card.score,
        band,
        reasonCodes,
        detail: `${card.resultType} ${card.score} → band ${band}`,
        billed: true,
        fromCache: false,
      };
    }
  }
}
