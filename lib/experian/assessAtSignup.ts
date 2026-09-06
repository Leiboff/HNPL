import { getScore, type ExperianConfig, type ExperianOutcome, type ScoreResult } from './client';
import { bandFor, gate, selectScorecard, type RiskBand } from './scores';
import { validateSaId, saIdAge } from '@/lib/validation';
import { hashIdForLookup } from '@/lib/idEncryption';

/**
 * Bureau assessment at sign-up.
 *
 * Adapted from docs/experian/assess-at-signup.ts — the verified reference,
 * which stays unmodified. `decide()` below is byte-identical to it; the
 * orchestration differs in three documented ways (the synchronous concurrency
 * guard, directly-imported validation and hashing rather than injected stubs,
 * and openAttempt returning null instead of throwing on a lost race).
 *
 * Order is load-bearing and each step exists to stop the next one being wasted
 * or unlawful:
 *
 *   consent gate → local ID validation → cache/dedupe → attempt row
 *     → billable call → decide → persist
 *
 * SERVER ONLY. Never reachable from a client component, and it must never
 * return raw reason descriptions to the browser — see the Assessment type.
 */

// ── Credit policy ─────────────────────────────────────────────────────────────
// These are BetterNow's numbers to set, and they are not set. Left null
// deliberately so an unconfigured deployment fails closed rather than issuing
// an allowance off an invented default.
//
// Exposure, not purchase value. The Purchase Allowance rule is applied
// downstream and is NOT implemented anywhere in this repository yet — see the
// PR description. Nothing here computes a purchase allowance.

/**
 * Ordered preference. The first scorecard present in the response with a usable score
 * wins. A list rather than a constant because what Experian returns depends on how the
 * branch is provisioned, not on what we ask for: pVersion 2.0 was expected to yield
 * Compuscore V3 (CT/CU) per the spec and actually returned Sigma Standard (SS) alone.
 *
 * STS is last and is load-bearing: pVersion 4.0 falls back to Sigma Transcend when the
 * primary card is unavailable, so leaving STS in this list means the fallback is picked
 * up automatically the moment Experian activate it on our branch — no deploy.
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
 * span the same numeric range. STS is different again — it is the thin-file scorecard
 * and its bands are much tighter (bands 2 and 3 are five and six points wide against
 * fourteen each on SU). Keying on band alone invites porting one card's calibration onto
 * another, which silently mis-prices every applicant.
 *
 * All null except the entry decline. These are BetterNow's numbers and must be
 * calibrated per card against Experian's bad-rate table, which has not been supplied.
 * Unconfigured means refer, never issue an allowance off an invented default.
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
  /** Stored for POPIA §71. Not for display. Codes only — never descriptions. */
  reasonCodes: string[];
  detail: string;
  billed: boolean;
  fromCache: boolean;
}

export interface AssessmentDeps {
  config: ExperianConfig;
  /**
   * True only if this profile has a RECORDED terms acceptance covering the
   * bureau clause. The production wiring reads profiles.terms_accepted_at and
   * profiles.terms_version — the acceptance ROW, never a rendered checkbox.
   */
  hasBureauConsent: (profileId: string) => Promise<boolean>;
  findFreshEnquiry: (idHash: string, ttlDays: number) => Promise<Assessment | null>;
  /**
   * Insert BEFORE the call so a timeout still leaves evidence of a possibly-billed
   * attempt.
   *
   * Returns null when the database's in-flight unique index refused the row because
   * another invocation already holds the slot for this ID. That is not an error to
   * retry — it means someone else is spending the money right now, and we must not
   * spend it again.
   */
  openAttempt: (row: { profileId: string; idHash: string; pVersion: string }) => Promise<string | null>;
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

// ─── The in-process half of the double-billing guard ──────────────────────
//
// A module-level map of the assessments currently in flight, keyed on the ID
// hash. A re-entrant call is COLLAPSED onto the running one and returns its
// promise, so N callers in the same tick produce exactly one billable call.
//
// This is the server-side analogue of the synchronous ref in
// components/loading/usePendingAction.ts, and it is a ref rather than
// anything async for exactly the reason documented there: a check that
// happens after an `await` is not a guard. Between the await and the
// resumption, every other caller has already passed the same check.
//
// Which is why the map is read AND written before this function's first
// await — see the comment at the top of assessAtSignup. Move either line
// after an await and N tabs bill N times.
//
// IT IS NOT SUFFICIENT ON ITS OWN, and this is the important half of the
// sentence. Serverless gives no guarantee that two concurrent requests reach
// the same Node instance, and a cold start begins with an empty map. So this
// collapses the common case (one user, two tabs, one warm lambda) and
// migration 0148's `bureau_enquiries_one_in_flight` unique partial index is
// the constraint that actually holds. Both, deliberately: the index alone
// would turn every double-tap into a refused enquiry rather than one shared
// answer, which is correct but a worse experience.
const inFlight = new Map<string, Promise<Assessment>>();

/** Test-only. Concurrency tests must not inherit a previous test's in-flight map. */
export function __resetInFlightForTests(): void {
  inFlight.clear();
}

function fail(decision: AssessmentDecision, detail: string, billed = false): Assessment {
  return {
    decision, riskExposureCents: null, scorecard: null, score: null, band: null,
    reasonCodes: [], detail, billed, fromCache: false,
  };
}

/**
 * Local SA ID checks, composed from the repo's EXISTING helpers rather than
 * reimplemented here.
 *
 * `validateSaId` covers length, format, the embedded date, the citizenship
 * digit and the Luhn checksum in one call; the 18+ comparison is the caller's
 * responsibility by that module's own contract, so it is spelled out here.
 * That makes this the third inline 18+ site (with lib/onboarding/actions.ts
 * and the Didit webhook) — deliberately, because changing shared validation to
 * suit this task is the larger evil.
 *
 * This runs before the call because an invalid ID returns -114 and is STILL
 * BILLED.
 */
function checkIdLocally(idNumber: string): { valid: boolean; reason?: string } {
  const check = validateSaId(idNumber);
  if (!check.valid) return { valid: false, reason: check.reason };

  const age = saIdAge(idNumber);
  if (age === null || age < 18) return { valid: false, reason: 'underage' };

  return { valid: true };
}

export function assessAtSignup(
  profileId: string,
  idNumber: string,
  deps: AssessmentDeps,
): Promise<Assessment> {
  // ── Everything down to `inFlight.set` is synchronous, on purpose ────────
  //
  // No `await` may appear above that line. The hash is a local HMAC over a
  // value we already hold — no I/O, no cost, and no bearing on lawfulness,
  // since what consent gates is the CALL and the call is several steps below
  // this. Computing it first is what lets the guard be entered with no await
  // in front of it, which is the whole point of the guard.
  let idHash: string;
  try {
    idHash = hashIdForLookup(idNumber.trim());
  } catch (err) {
    // hashIdForLookup throws when SA_ID_LOOKUP_HMAC_KEY is missing or the
    // wrong length. Fail closed: with no hash there is no cache key and no
    // in-flight guard, so a call made anyway could bill without limit.
    return Promise.resolve(fail(
      'error',
      `could not derive ID hash: ${err instanceof Error ? err.message : 'unknown'}`,
    ));
  }

  const running = inFlight.get(idHash);
  if (running) return running;

  const promise = runAssessment(profileId, idNumber, idHash, deps)
    .finally(() => { inFlight.delete(idHash); });
  inFlight.set(idHash, promise);
  return promise;
}

async function runAssessment(
  profileId: string,
  idNumber: string,
  idHash: string,
  deps: AssessmentDeps,
): Promise<Assessment> {
  // 1. Consent. The lawful basis for the enquiry lives in the accepted T&Cs, so this
  //    reads the ACCEPTANCE ROW, not the signup checkbox. A rendered checkbox is not a
  //    recorded consent, and this is the last point before money and before a permanent
  //    entry on a real person's credit file.
  let consented: boolean;
  try {
    consented = await deps.hasBureauConsent(profileId);
  } catch (err) {
    // A failed consent read is NOT "no consent" and it is certainly not "consent".
    // Same posture as findPatientBySaId: an unreadable answer fails closed.
    return fail('error', `consent check failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  if (!consented) {
    return fail('error', 'no recorded bureau consent for this profile');
  }

  // 2. Local validation before spending money. -114 is billable.
  const local = checkIdLocally(idNumber);
  if (!local.valid) return fail('error', `local ID validation failed: ${local.reason ?? 'invalid'}`);

  // 3. Cache. Re-pulling costs money AND damages the consumer's own score.
  let cached: Assessment | null;
  try {
    cached = await deps.findFreshEnquiry(idHash, CACHE_TTL_DAYS);
  } catch (err) {
    // Fail closed rather than falling through to a fresh billable call: a
    // database blip must not become a second enquiry on someone's file.
    return fail('error', `cache read failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  if (cached) return { ...cached, fromCache: true };

  // 4. The attempt row, before the call, so a timeout still leaves evidence.
  let attemptId: string | null;
  try {
    attemptId = await deps.openAttempt({ profileId, idHash, pVersion: deps.config.pVersion });
  } catch (err) {
    return fail('error', `could not open enquiry attempt: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  if (attemptId === null) {
    // The database's in-flight index refused us. Another invocation is already
    // spending this transaction; we must not spend it twice.
    return fail('error', 'an enquiry for this ID is already in flight');
  }

  // 5. The billable call. No retries here — see getScore.
  const outcome = await getScore(idNumber, deps.config);
  const assessment = decide(outcome);

  try {
    await deps.closeAttempt(attemptId, {
      outcome: outcome.kind,
      errorCode: 'errorCode' in outcome ? outcome.errorCode : null,
      latencyMs: outcome.latencyMs,
      billed: assessment.billed,
      results: outcome.kind === 'ok' ? outcome.results : null,
      rawPayload: outcome.kind === 'ok' ? outcome.raw : null,
      assessment,
    });
  } catch {
    // The call happened and may have billed. Losing the write is bad for
    // reconciliation, but returning an error here would be worse: it would
    // discard a decision we have already paid for and invite a retry that
    // pays again. The open row remains as the artefact.
    //
    // Deliberately no logging of the error object: nothing in this scope is
    // guaranteed free of the request body, and this file must never put
    // credentials anywhere near a log line.
  }

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
