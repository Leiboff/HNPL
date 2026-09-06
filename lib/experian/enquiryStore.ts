import type { Assessment, AssessmentDeps } from './assessAtSignup';
import type { ExperianOutcome, ScoreResult } from './client';
import type { RiskBand } from './scores';

// ─── bureau_enquiries, from the application side ──────────────────────
//
// The three database operations assessAtSignup needs, against migration
// 0148. Kept out of assessAtSignup itself so the decision logic is testable
// against plain objects rather than a database — the transport is exercised
// with a mocked fetch, and these are exercised by the RLS test beside the
// migration.
//
// SERVICE ROLE ONLY. bureau_enquiries has RLS enabled with no policies and
// the default anon/authenticated grants revoked, so nothing else can reach
// it. Callers pass in the service-role client rather than this module
// building one, matching how findPatientBySaId takes its `svc`.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

/** Postgres unique-violation. The in-flight index raising this is the guard working. */
const UNIQUE_VIOLATION = '23505';

type EnquiryRow = {
  decision: string | null;
  scorecard: string | null;
  score: number | null;
  risk_band: number | null;
  risk_exposure_cents: number | null;
  reason_codes: string[] | null;
  decision_detail: string | null;
  billed: boolean | null;
};

/**
 * The decisions worth serving from cache.
 *
 * 'error' is deliberately absent. A transport failure, a config fault or a
 * -114 is not a decision ABOUT THE APPLICANT, and caching one would suppress
 * a legitimate enquiry for 45 days on the strength of our own outage. The
 * controls that stop error-retry becoming a cost spiral already exist and
 * already run before this: the per-account rate limit and the daily bureau
 * budget in runCreditCheck.
 */
const CACHEABLE_DECISIONS = ['approved', 'declined', 'referred'];

function rowToAssessment(row: EnquiryRow): Assessment {
  return {
    decision: (row.decision ?? 'error') as Assessment['decision'],
    riskExposureCents: row.risk_exposure_cents ?? null,
    scorecard: row.scorecard ?? null,
    score: row.score ?? null,
    band: (row.risk_band ?? null) as RiskBand | null,
    reasonCodes: row.reason_codes ?? [],
    detail: row.decision_detail ?? '',
    billed: row.billed ?? false,
    fromCache: true,
  };
}

/**
 * The most recent decisive enquiry for this ID hash inside the TTL, or null.
 *
 * A read failure THROWS rather than returning null. "We could not read the
 * cache" is not "there is no cache entry": treating it as a miss would spend
 * money and put a second enquiry on someone's file every time the database
 * hiccuped. assessAtSignup catches it and fails closed — same posture as
 * findPatientBySaId.
 */
export async function findFreshEnquiry(
  svc: Svc,
  idHash: string,
  ttlDays: number,
): Promise<Assessment | null> {
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await svc
    .from('bureau_enquiries')
    .select('decision, scorecard, score, risk_band, risk_exposure_cents, reason_codes, decision_detail, billed')
    .eq('id_number_hash', idHash)
    .not('completed_at', 'is', null)
    .in('decision', CACHEABLE_DECISIONS)
    .gte('requested_at', cutoff)
    .order('requested_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`findFreshEnquiry: bureau_enquiries read failed — ${error.message ?? String(error)}`);
  }

  const row = ((data ?? []) as EnquiryRow[])[0];
  return row ? rowToAssessment(row) : null;
}

/**
 * Open an attempt row BEFORE the billable call.
 *
 * Returns the row id, or null when the in-flight unique index refused it
 * because another invocation already holds the slot for this ID. Null is not
 * an error to retry — it means someone else is spending the money right now.
 *
 * Detecting the race by CATCHING the constraint rather than by SELECTing
 * first is deliberate and is the same argument as the Didit webhook's
 * idempotency ledger in 0102: a check-then-act leaves a window between the
 * look and the insert, and this particular window costs a billable
 * transaction.
 */
export async function openAttempt(
  svc: Svc,
  row: { profileId: string; idHash: string; pVersion: string },
): Promise<string | null> {
  const { data, error } = await svc
    .from('bureau_enquiries')
    .insert({
      profile_id: row.profileId,
      id_number_hash: row.idHash,
      p_version: row.pVersion,
    })
    .select('id')
    .single();

  if (error) {
    const raw = `${error.code ?? ''} ${error.message ?? ''}`;
    if (error.code === UNIQUE_VIOLATION || /bureau_enquiries_one_in_flight/.test(raw)) {
      return null;
    }
    throw new Error(`openAttempt: bureau_enquiries insert failed — ${error.message ?? String(error)}`);
  }

  return (data as { id: string }).id;
}

/**
 * Close the attempt with what came back. Setting completed_at is what
 * releases the in-flight slot, so this must run on every path out of the
 * call — including the error paths.
 */
export async function closeAttempt(
  svc: Svc,
  attemptId: string,
  row: {
    outcome: ExperianOutcome['kind'];
    errorCode: string | null;
    latencyMs: number;
    billed: boolean;
    results: ScoreResult[] | null;
    rawPayload: string | null;
    assessment: Assessment;
  },
): Promise<void> {
  const a = row.assessment;

  const { error } = await svc
    .from('bureau_enquiries')
    .update({
      completed_at: new Date().toISOString(),
      latency_ms: row.latencyMs,
      outcome: row.outcome,
      error_code: row.errorCode,
      billed: row.billed,
      raw_payload: row.rawPayload,
      results: row.results,
      decision: a.decision,
      scorecard: a.scorecard,
      // The CHECK on this column refuses a negative, which is the point: a
      // warning code is not a score. decide() never puts one here, and if a
      // regression ever does, the write fails instead of filing a deceased
      // consumer under credit risk.
      score: a.score !== null && a.score >= 0 ? a.score : null,
      risk_band: a.band,
      risk_exposure_cents: a.riskExposureCents,
      reason_codes: a.reasonCodes,
      decision_detail: a.detail,
    })
    .eq('id', attemptId);

  if (error) {
    throw new Error(`closeAttempt: bureau_enquiries update failed — ${error.message ?? String(error)}`);
  }
}

/**
 * The three I/O dependencies, bound to a service-role client.
 *
 * `hasBureauConsent` is supplied by the caller rather than built here because
 * the caller has ALREADY read the profile row that answers it — see
 * PROFILE_SELECT in lib/onboarding/actions.ts. Passing a closure over that row
 * means the consent gate costs no additional round trip, the same argument
 * lib/legal/termsGate.ts makes for taking a row instead of reading one.
 */
export function enquiryStoreDeps(
  svc: Svc,
  hasBureauConsent: AssessmentDeps['hasBureauConsent'],
): Omit<AssessmentDeps, 'config'> {
  return {
    hasBureauConsent,
    findFreshEnquiry: (idHash, ttlDays) => findFreshEnquiry(svc, idHash, ttlDays),
    openAttempt: (row) => openAttempt(svc, row),
    closeAttempt: (attemptId, row) => closeAttempt(svc, attemptId, row),
  };
}
