// ─── The gate ordering, in one place ────────────────────────────────────
//
// The pipeline runs ONCE, at sign-up, and establishes a standing limit.
// Individual plans afterwards draw against that limit and trigger no
// bureau calls at all (see claimCredit.ts).
//
//   0. verified email + cellphone      existing registration flow
//   1. bureau score                    ← cheap. Gates everything below.
//   2. identity                        ← BILLABLE
//   3. salary date + declared income   patient input, free
//   4. affordability                   ← BILLABLE
//   5. limit calculation               pure
//   6. persist limit + assessment log
//
// ─── WHY THE BILLABLE CALLS ARE INJECTED ───────────────────────────────
//
// The ordering IS the feature. Each gate exists to avoid paying for the
// step behind it, and a refactor that made the code tidier while calling
// affordability earlier — or in parallel with identity — would be wrong
// even if every other test still passed.
//
// So the two functions below take the billable operations as callbacks
// rather than importing them. That is not indirection for its own sake: it
// means a test can hand in spies and assert NOT-CALLED, which is the only
// way to test the absence of a side effect. The production callers pass
// the real clients; the invariant is then enforced by the same code the
// tests exercise rather than by a parallel implementation.
//
// ─── PENDING IS NOT A DECLINE ──────────────────────────────────────────
//
// Every outcome here distinguishes them. A `declined` result is
// substantive — a band below average risk, an identity mismatch, a limit
// under the minimum — and enters the decline cooldown. A `pending` result
// means we could not get an answer, does not enter the cooldown, and must
// never be presented to a patient as a refusal.

import type { ScoreCallOutcome } from '@/lib/experian/scoreClient';
import type { AffordabilityCallOutcome } from '@/lib/experian/affordabilityClient';
import type { BandCutoffs } from '@/lib/experian/bands';
import {
  decideScoreGate,
  scoreGatePasses,
  bandFromDecision,
  type ScoreGateDecision,
} from './scoreGate';
import { resolveAffordability, type AffordabilityResolution } from './affordabilityGate';
import {
  calculateCreditLimit,
  type DeclaredGross,
  type LimitOutcome,
} from './limit';
import type { ScorecardBand } from './coefficients';

// ═══ Stage 1: the score gate, guarding the identity spend ══════════════

export type IdentityGateDeps<T> = {
  /** The bureau score call. Cheap relative to what it guards. */
  score: (idNumber: string) => Promise<ScoreCallOutcome>;
  /** Ordered scorecard preference. */
  preference: readonly string[];
  /** Band table for the configured score family. */
  cards: Readonly<Record<string, BandCutoffs>>;
  /**
   * The BILLABLE identity ceremony — registry lookup plus face-match
   * session. Invoked only when the score gate passes. If this is called on
   * a declined score, the gate is broken.
   */
  startIdentity: () => Promise<T>;
  /** Write the assessment row. Called for every outcome, including declines. */
  recordScore?: (decision: ScoreGateDecision) => Promise<void>;
  /**
   * Cooldown and existing-assessment check. Runs BEFORE the score call, so
   * a declined applicant inside their cooldown cannot re-trigger a
   * billable enquiry by re-registering.
   */
  precheck?: () => Promise<{ blocked: true; reason: string; until?: Date } | { blocked: false }>;
};

export type IdentityGateResult<T> =
  /** Score passed (or thin file). The identity ceremony was started. */
  | { kind: 'identity_started'; result: T; decision: ScoreGateDecision; band: ScorecardBand }
  /** Substantive refusal at the score gate. Nothing billable was spent. */
  | { kind: 'declined'; decision: ScoreGateDecision }
  /** No answer from the bureau. Not a refusal. Retryable. */
  | { kind: 'pending'; decision: ScoreGateDecision }
  /** Blocked before any call — cooldown, or an assessment already in force. */
  | { kind: 'blocked'; reason: string; until?: Date };

/**
 * Run the score gate and, only on a pass, start identity verification.
 *
 * `idNumber` MUST already be checksum-validated and the applicant 18+.
 * Those checks are free and a -114 is a wasted billable enquiry.
 */
export async function gateIdentityOnScore<T>(
  deps: IdentityGateDeps<T>,
  idNumber: string,
): Promise<IdentityGateResult<T>> {
  const pre = await deps.precheck?.();
  if (pre?.blocked) {
    // Nothing billable has run. This is the whole point of the cooldown.
    return { kind: 'blocked', reason: pre.reason, until: pre.until };
  }

  const outcome  = await deps.score(idNumber);
  const decision = decideScoreGate(outcome, deps.preference, deps.cards);

  await deps.recordScore?.(decision);

  if (decision.kind === 'decline') {
    return { kind: 'declined', decision };
  }

  if (!scoreGatePasses(decision)) {
    // pending — no answer. The patient is not refused and must not be told
    // they were; nothing billable runs.
    return { kind: 'pending', decision };
  }

  const band = bandFromDecision(decision);
  if (band === null) {
    // Unreachable: scoreGatePasses is true only for pass and thin_file,
    // both of which yield a band. Treated as pending rather than trusted.
    return { kind: 'pending', decision };
  }

  const result = await deps.startIdentity();
  return { kind: 'identity_started', result, decision, band };
}

// ═══ Stage 2: identity, guarding the affordability spend ═══════════════

export type IdentityStatus = 'passed' | 'failed' | 'pending';

export type AffordabilityGateDeps = {
  /**
   * The identity outcome as persisted by the verification webhook. Read
   * BEFORE the affordability call, and the call does not happen unless
   * this returns 'passed'.
   */
  identityStatus: () => Promise<IdentityStatus>;
  /** The BILLABLE affordability enquiry. */
  affordability: (idNumber: string) => Promise<AffordabilityCallOutcome>;
};

export type AssessmentResult =
  | {
      kind: 'assessed';
      /** The limit decision — itself possibly a decline. */
      limit: LimitOutcome;
      resolution: AffordabilityResolution;
      band: ScorecardBand;
    }
  /** Identity has not passed. Nothing billable was spent. */
  | { kind: 'identity_not_passed'; status: IdentityStatus }
  /** No answer from the bureau. Not a refusal. */
  | { kind: 'pending'; detail: string; alert: boolean };

/**
 * Run the affordability enquiry and price a limit — but only once identity
 * has actually passed.
 *
 * The identity read is deliberately the FIRST thing here and the
 * affordability callback is unreachable until it returns 'passed'. A
 * pending identity is not a decline either: the patient's face-match may
 * still be in flight.
 */
export async function gateAffordabilityOnIdentity(
  deps: AffordabilityGateDeps,
  input: {
    idNumber: string;
    /** The band the score gate produced. */
    scoreBand: ScorecardBand;
    /** From the income page. Can only ever lower the limit. */
    declared: DeclaredGross | null;
  },
): Promise<AssessmentResult> {
  const status = await deps.identityStatus();
  if (status !== 'passed') {
    return { kind: 'identity_not_passed', status };
  }

  const outcome    = await deps.affordability(input.idNumber);
  const resolution = resolveAffordability(outcome, input.scoreBand);

  if (resolution.kind === 'pending') {
    return { kind: 'pending', detail: resolution.detail, alert: resolution.alert };
  }

  const limit = calculateCreditLimit({
    band:       resolution.band,
    prediction: resolution.prediction,
    declared:   input.declared,
  });

  return { kind: 'assessed', limit, resolution, band: resolution.band };
}

/** True when an assessment result should enter the decline cooldown. */
export function entersCooldown(
  result: IdentityGateResult<unknown> | AssessmentResult,
): boolean {
  if (result.kind === 'declined') return true;
  if (result.kind === 'assessed') return result.limit.decision === 'declined';
  // pending, blocked, identity_not_passed, identity_started — none of these
  // are refusals.
  return false;
}
