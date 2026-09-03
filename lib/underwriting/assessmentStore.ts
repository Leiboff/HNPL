// SERVER-ONLY. Never import in a client component.
//
// ─── Writing the assessment down ────────────────────────────────────────
//
// Two writes per assessment, and they are not the same thing:
//
//   • one row appended to `credit_assessments` — immutable history, one
//     per assessment, approved AND declined AND pending
//   • the patient's profile updated to the new current state
//
// The row is built by a PURE function so the mapping from pipeline result
// to log row is testable without a database. That matters more than it
// looks: this table is the entire basis for recalibrating the
// coefficients, and a field silently left null on one branch would not
// show up until someone tried to run the analysis months later.

import { COEFFICIENT_VERSION, type ScorecardBand } from './coefficients';
import type { LimitOutcome } from './limit';
import type { ScoreGateDecision, ScoreSnapshot } from './scoreGate';
import type { AffordabilityResolution } from './affordabilityGate';
import {
  cooldownFrom,
  statusForOutcome,
  type AssessmentSnapshot,
  type AssessmentTrigger,
} from './assessmentState';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

export type AssessmentOutcome = 'approved' | 'declined' | 'pending';

export type AssessmentRow = {
  patient_id: string;
  sa_id_lookup_hash: string | null;
  trigger: AssessmentTrigger;
  outcome: AssessmentOutcome;
  failed_gate: 'score' | 'identity' | 'affordability' | 'limit' | null;
  decline_reason: string | null;
  pending_reason: string | null;

  score_value: number | null;
  score_result_type: string | null;
  score_family: string | null;
  scorecard_band: string | null;
  score_results: unknown;

  gmip_value: number | null;
  gmip_confidence_level: string | null;
  gmip_band: string | null;
  bureau_expenses: number | null;
  calc_living_expenses: number | null;
  experian_disposable_income: number | null;
  enq_id: string | null;
  thin_file_reason: string | null;

  computed_net: number | null;
  computed_living: number | null;
  computed_ndi: number | null;
  computed_monthly: number | null;
  computed_facility: number | null;
  final_limit: number | null;
  binding_constraint: string | null;
  /** The deciding card's own cap, when it had one. */
  scorecard_cap: number | null;

  declared_income: number | null;
  coefficient_version: string;
};

export type BuildAssessmentInput = {
  patientId: string;
  saIdLookupHash: string | null;
  trigger: AssessmentTrigger;
  scoreFamilyLabel: string | null;
  /** Absent when the pipeline never reached the score (e.g. blocked). */
  scoreDecision: ScoreGateDecision | null;
  /** Absent when the pipeline stopped before affordability. */
  resolution: AffordabilityResolution | null;
  /** Absent when the pipeline stopped before pricing. */
  limit: LimitOutcome | null;
  /** Set when identity is why this stopped. */
  identityFailed?: boolean;
  declaredIncome: number | null;
  /**
   * The score result carried forward from the identity step, for the
   * pricing row written in a LATER request. Used only when
   * `scoreDecision` is absent — a decision in hand always wins.
   */
  scoreSnapshot?: ScoreSnapshot | null;
};

function scoreDeclineReason(decision: ScoreGateDecision): string | null {
  return decision.kind === 'decline' ? decision.reason : null;
}

/**
 * The band the score gate produced, on ANY branch that has one.
 *
 * A band decline carries a band, and it is the single most useful field on
 * a declined row: "how many very-high-risk applicants did we turn away"
 * cannot be answered without it. An earlier version of this function only
 * read the band off passing decisions and wrote null for every refusal,
 * which would have left exactly the population we most need to measure
 * unmeasurable.
 */
function scoreBand(decision: ScoreGateDecision | null): ScorecardBand | null {
  if (decision === null) return null;
  if (decision.kind === 'pass')      return decision.band;
  if (decision.kind === 'thin_file') return 'thin_file';
  if (decision.kind === 'decline')   return decision.band;
  return null;
}

/**
 * Build the log row from whatever the pipeline produced.
 *
 * Every branch writes a row. A decline with no workings tells us nothing
 * at calibration time, and a pipeline that only logged approvals would
 * leave us tuning coefficients on the population we already said yes to.
 */
export function buildAssessmentRow(input: BuildAssessmentInput): AssessmentRow {
  const { scoreDecision: sd, resolution, limit } = input;

  // ── Outcome, and which gate ended it ─────────────────────────────────
  let outcome: AssessmentOutcome = 'pending';
  let failedGate: AssessmentRow['failed_gate'] = null;
  let declineReason: string | null = null;
  let pendingReason: string | null = null;

  if (sd?.kind === 'decline') {
    outcome = 'declined';
    failedGate = 'score';
    declineReason = scoreDeclineReason(sd);
  } else if (input.identityFailed) {
    outcome = 'declined';
    failedGate = 'identity';
    declineReason = 'identity_mismatch';
  } else if (sd?.kind === 'pending') {
    outcome = 'pending';
    failedGate = 'score';
    pendingReason = sd.detail;
  } else if (resolution?.kind === 'pending') {
    outcome = 'pending';
    failedGate = 'affordability';
    pendingReason = resolution.detail;
  } else if (limit?.decision === 'declined') {
    outcome = 'declined';
    failedGate = 'limit';
    declineReason = limit.reason === 'band' ? 'band' : 'below_minimum';
  } else if (limit?.decision === 'approved') {
    outcome = 'approved';
  }

  const data = resolution?.kind === 'ready' ? resolution.data : null;
  const workings = limit?.workings ?? null;

  // The band actually applied — the affordability stage can downgrade the
  // score's band to thin_file, and the log must show which one priced it.
  const snap = input.scoreSnapshot ?? null;

  const band: ScorecardBand | null =
    workings?.band
    ?? (resolution?.kind === 'ready' ? resolution.band : null)
    ?? scoreBand(sd)
    ?? snap?.band
    ?? null;

  return {
    patient_id:        input.patientId,
    sa_id_lookup_hash: input.saIdLookupHash,
    trigger:           input.trigger,
    outcome,
    failed_gate:       failedGate,
    decline_reason:    declineReason,
    pending_reason:    pendingReason,

    // A decision in hand wins; otherwise the snapshot carried from the
    // identity step. Without the fallback the pricing row — the ONE row a
    // completed assessment produces — would have no score on it at all.
    score_value:       sd?.kind === 'pass' ? sd.score
                       : sd?.kind === 'decline' ? sd.score
                       : sd?.kind === 'thin_file' ? sd.score
                       : snap?.value ?? null,
    score_result_type: sd && 'resultType' in sd ? sd.resultType : (snap?.resultType ?? null),
    score_family:      input.scoreFamilyLabel,
    scorecard_band:    band,
    // Every card, not just the deciding one.
    score_results:     sd && 'results' in sd && sd.results.length > 0
                         ? sd.results
                         : (snap && snap.results.length > 0 ? snap.results : null),

    gmip_value:                 data?.gmipValue ?? null,
    gmip_confidence_level:      data?.gmipConfidenceLevel ?? null,
    gmip_band:                  data?.gmipBand ?? null,
    bureau_expenses:            data?.bureauExpenses ?? null,
    calc_living_expenses:       data?.calcLivingExpenses ?? null,
    // Experian's own figure, unmodified, beside ours.
    experian_disposable_income: data?.disposableIncome ?? null,
    enq_id:                     data?.enqId ?? null,
    thin_file_reason:           resolution?.kind === 'ready' ? resolution.thinFileReason : null,

    computed_net:       workings?.net?.monthlyNet ?? null,
    computed_living:    workings?.living ?? null,
    computed_ndi:       workings?.ndi ?? null,
    computed_monthly:   workings?.monthly ?? null,
    computed_facility:  workings?.facility ?? null,
    final_limit:        limit?.decision === 'approved' ? limit.limit : null,
    binding_constraint: limit?.binding ?? null,
    // Recorded separately from the band ceiling so the true band stays
    // visible and the cap can be revisited on evidence.
    scorecard_cap:      workings?.scorecardCap ?? null,

    declared_income:     input.declaredIncome,
    coefficient_version: workings?.coefficientVersion ?? COEFFICIENT_VERSION,
  };
}

/** What the profile should look like after this assessment. */
export function profileUpdateFor(
  row: AssessmentRow,
  assessmentId: string,
  now: Date,
): Record<string, unknown> {
  const status = statusForOutcome(row.outcome);

  const update: Record<string, unknown> = {
    credit_assessment_status:     status,
    scorecard_band:               row.scorecard_band,
    current_credit_assessment_id: assessmentId,
  };

  if (row.outcome === 'approved') {
    update.approved_credit_limit     = row.final_limit;
    update.credit_check_completed_at = now.toISOString();
    update.credit_check_status       = 'passed';
    // A fresh approval clears any historical cooldown.
    update.credit_decline_cooldown_until = null;
  }

  if (row.outcome === 'declined') {
    update.credit_check_status            = 'failed';
    update.credit_check_completed_at      = now.toISOString();
    update.credit_decline_cooldown_until  = cooldownFrom(now).toISOString();
    // A decline does not grant a limit, and must not leave a stale one in
    // force from a previous assessment.
    update.approved_credit_limit          = null;
  }

  if (row.outcome === 'pending') {
    // Deliberately does NOT set a cooldown, does NOT clear an existing
    // limit, and does NOT mark the onboarding step failed. We could not
    // assess this patient; that is not a decision about them.
    update.credit_check_status = 'pending';
  }

  return update;
}

// ── I/O ────────────────────────────────────────────────────────────────

/** Append the assessment row. Returns its id. */
export async function recordAssessment(svc: Svc, row: AssessmentRow): Promise<string | null> {
  const { data, error } = await svc
    .from('credit_assessments')
    .insert(row)
    .select('id')
    .maybeSingle();

  if (error) {
    // Never swallowed: a lost assessment row is a hole in the calibration
    // data that cannot be reconstructed later.
    console.error('[assessment] ALERT failed to write the assessment log', {
      patientId: row.patient_id, outcome: row.outcome, error: error.message,
    });
    return null;
  }
  return (data?.id as string) ?? null;
}

/** Apply the assessment to the patient's current state. */
export async function applyAssessment(
  svc: Svc,
  patientId: string,
  row: AssessmentRow,
  assessmentId: string,
  now: Date = new Date(),
): Promise<{ ok: boolean }> {
  const { error } = await svc
    .from('profiles')
    .update(profileUpdateFor(row, assessmentId, now))
    .eq('id', patientId);

  if (error) {
    console.error('[assessment] failed to apply the assessment to the profile', {
      patientId, error: error.message,
    });
    return { ok: false };
  }
  return { ok: true };
}

/** Read the patient's current assessment state. */
export async function readSnapshot(
  svc: Svc,
  patientId: string,
): Promise<AssessmentSnapshot | null> {
  const { data, error } = await svc
    .from('profiles')
    .select('approved_credit_limit, credit_check_completed_at, credit_assessment_status, '
          + 'credit_decline_cooldown_until, scorecard_band')
    .eq('id', patientId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    limit:         data.approved_credit_limit === null ? null : Number(data.approved_credit_limit),
    assessedAt:    data.credit_check_completed_at ?? null,
    status:        data.credit_assessment_status ?? null,
    cooldownUntil: data.credit_decline_cooldown_until ?? null,
    band:          data.scorecard_band ?? null,
  };
}

/**
 * The cooldown in force for an ID number, regardless of which account it
 * is attached to.
 *
 * Matched on the blind index rather than on the patient row, because the
 * whole point is to catch a declined applicant who has re-registered with
 * a fresh email and phone. Returns the expiry when one is still running.
 */
export async function cooldownForIdHash(
  svc: Svc,
  saIdLookupHash: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const { data, error } = await svc
    .from('credit_assessments')
    .select('created_at')
    .eq('sa_id_lookup_hash', saIdLookupHash)
    .eq('outcome', 'declined')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    // Fail CLOSED would block every applicant on a transient read error;
    // fail open would let a declined one through. The compromise is to
    // report no cooldown but log loudly — the per-account cooldown on the
    // profile still applies, so this is a second line rather than the only
    // one.
    console.error('[assessment] cooldown lookup failed', { error: error.message });
    return null;
  }

  const rows = (data ?? []) as Array<{ created_at: string }>;
  if (rows.length === 0) return null;

  const until = cooldownFrom(new Date(rows[0].created_at));
  return until.getTime() > now.getTime() ? until : null;
}

/**
 * The score snapshot the identity step left on the profile.
 *
 * Returns null when there is none — a patient assessed before this
 * existed, or one whose score stage has not run. The pricing row is still
 * written; it simply carries no score fields, which is visible in the data
 * rather than silently wrong.
 */
export async function readScoreSnapshot(
  svc: Svc,
  patientId: string,
): Promise<ScoreSnapshot | null> {
  const { data, error } = await svc
    .from('profiles')
    .select('last_score_snapshot')
    .eq('id', patientId)
    .maybeSingle();

  if (error || !data?.last_score_snapshot) return null;
  return data.last_score_snapshot as ScoreSnapshot;
}

/** Persist the score snapshot and band without writing an assessment row. */
export async function saveScoreSnapshot(
  svc: Svc,
  patientId: string,
  snapshot: ScoreSnapshot,
): Promise<void> {
  const { error } = await svc
    .from('profiles')
    .update({ last_score_snapshot: snapshot, scorecard_band: snapshot.band })
    .eq('id', patientId);

  if (error) {
    console.error('[assessment] failed to save the score snapshot', {
      patientId, error: error.message,
    });
  }
}
