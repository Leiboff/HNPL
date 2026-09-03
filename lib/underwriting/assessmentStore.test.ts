import { describe, it, expect } from 'vitest';
import { buildAssessmentRow, profileUpdateFor, type BuildAssessmentInput } from './assessmentStore';
import { decideScoreGate } from './scoreGate';
import { resolveAffordability } from './affordabilityGate';
import { calculateCreditLimit, declaredGross } from './limit';
import { parseGetScoreResponse } from '@/lib/experian/scoreClient';
import { parseAffordabilityResponse } from '@/lib/experian/affordabilityClient';
import { SIGMA_BANDS } from '@/lib/experian/bands';
import { DEFAULT_SCORECARD_PREFERENCE } from '@/lib/experian/config';
import * as score from '@/lib/experian/__fixtures__/score';
import * as afford from '@/lib/experian/__fixtures__/affordability';

const PREF = [...DEFAULT_SCORECARD_PREFERENCE];
const NOW  = new Date('2026-09-03T12:00:00Z');
const PATIENT = 'patient-1';

const gate = (xml: string) => decideScoreGate(parseGetScoreResponse(xml), PREF, SIGMA_BANDS);

function base(over: Partial<BuildAssessmentInput> = {}): BuildAssessmentInput {
  return {
    patientId: PATIENT,
    saIdLookupHash: 'hash-abc',
    trigger: 'signup',
    scoreFamilyLabel: 'Sigma',
    scoreDecision: null,
    resolution: null,
    limit: null,
    declaredIncome: null,
    ...over,
  };
}

/** The full happy path, end to end through the real modules. */
function approvedRun(declared: number | null = null) {
  const sd = gate(score.SCORE_SUCCESS_SU_SCORED_660);
  const resolution = resolveAffordability(
    parseAffordabilityResponse(afford.AFFORD_SUCCESS_HIGH),
    sd.kind === 'pass' ? sd.band : 'thin_file',
  );
  if (resolution.kind !== 'ready') throw new Error('expected a resolution');
  const limit = calculateCreditLimit({
    band: resolution.band,
    prediction: resolution.prediction,
    declared: declared === null ? null : declaredGross(declared),
  });
  return base({ scoreDecision: sd, resolution, limit, declaredIncome: declared });
}

// ─── Every branch writes a row ──────────────────────────────────────────

describe('every pipeline branch produces a log row', () => {
  it('an approval carries the full workings', () => {
    const row = buildAssessmentRow(approvedRun());

    expect(row.outcome).toBe('approved');
    expect(row.failed_gate).toBeNull();
    expect(row.final_limit).toBe(10_000);
    expect(row.binding_constraint).toBe('band_ceiling');
    expect(row.computed_net).toBeGreaterThan(0);
    expect(row.computed_ndi).toBeGreaterThan(0);
    expect(row.computed_facility).toBeGreaterThan(0);
    expect(row.coefficient_version).toMatch(/^\d{4}\.\d{2}-r\d+$/);
  });

  it('a score decline records which gate and why', () => {
    const row = buildAssessmentRow(base({ scoreDecision: gate(score.SCORE_SUCCESS_SU_VERY_HIGH) }));

    expect(row.outcome).toBe('declined');
    expect(row.failed_gate).toBe('score');
    expect(row.decline_reason).toBe('band');
    expect(row.scorecard_band).toBe('very_high');
    expect(row.final_limit).toBeNull();
    // Still versioned — a decline has to be interpretable later too.
    expect(row.coefficient_version).toBeTruthy();
  });

  it.each([
    ['deceased',     score.SCORE_SENTINEL_DECEASED],
    ['debt_review',  score.SCORE_SENTINEL_DEBT_REVIEW],
  ])('a %s sentinel is recorded as that specific reason', (reason, xml) => {
    const row = buildAssessmentRow(base({ scoreDecision: gate(xml) }));
    expect(row.outcome).toBe('declined');
    expect(row.decline_reason).toBe(reason);
  });

  it('an identity failure is recorded against the identity gate', () => {
    const row = buildAssessmentRow(base({
      scoreDecision: gate(score.SCORE_SUCCESS_SU_SCORED_660),
      identityFailed: true,
    }));
    expect(row.outcome).toBe('declined');
    expect(row.failed_gate).toBe('identity');
    expect(row.decline_reason).toBe('identity_mismatch');
  });

  it('a sub-minimum limit is recorded against the limit gate', () => {
    const sd = gate(score.SCORE_SUCCESS_SU_SCORED_660);
    const resolution = resolveAffordability(
      parseAffordabilityResponse(afford.affordabilityReply({
        GMIP_Value: '5000', GMIP_Confidence_Level: 'High',
        Bureau_Expenses: '2000', Calc_Living_Expenses: '2000', Enq_id: 'E',
      })), 'low');
    if (resolution.kind !== 'ready') throw new Error('expected a resolution');
    const limit = calculateCreditLimit({
      band: resolution.band, prediction: resolution.prediction, declared: null });

    const row = buildAssessmentRow(base({ scoreDecision: sd, resolution, limit }));

    expect(row.outcome).toBe('declined');
    expect(row.failed_gate).toBe('limit');
    expect(row.decline_reason).toBe('below_minimum');
    // The workings are still recorded — that is what makes the decline
    // usable for calibration.
    expect(row.computed_facility).toBeCloseTo(570, 6);
  });

  it('a bureau outage is recorded as pending, not declined', () => {
    const row = buildAssessmentRow(base({ scoreDecision: gate(score.SCORE_SOAP_FAULT_500) }));

    expect(row.outcome).toBe('pending');
    expect(row.decline_reason).toBeNull();
    expect(row.pending_reason).toContain('SOAP fault');
  });

  it('an affordability outage is pending against the affordability gate', () => {
    const sd = gate(score.SCORE_SUCCESS_SU_SCORED_660);
    const resolution = resolveAffordability(
      parseAffordabilityResponse(afford.AFFORD_ERROR_205_NOT_ACTIVATED), 'low');

    const row = buildAssessmentRow(base({ scoreDecision: sd, resolution }));

    expect(row.outcome).toBe('pending');
    expect(row.failed_gate).toBe('affordability');
    expect(row.pending_reason).toContain('-205');
  });
});

// ─── What the log has to carry for calibration ──────────────────────────

describe('the fields calibration depends on', () => {
  it('keeps Experian\'s own disposable income beside ours', () => {
    // If a cohort goes bad we need to see whether the bureau saw it coming
    // and our overlay masked it.
    const row = buildAssessmentRow(approvedRun());
    expect(row.experian_disposable_income).toBe(17_200);
    expect(row.computed_ndi).not.toBe(row.experian_disposable_income);
    expect(row.computed_ndi).toBeGreaterThan(0);
  });

  it('records every scorecard returned, not just the deciding one', () => {
    const row = buildAssessmentRow(base({
      scoreDecision: gate(score.SCORE_SUCCESS_SU_UNSCORABLE_STS_620),
    }));
    const results = row.score_results as Array<{ resultType: string }>;
    expect(results.map((r) => r.resultType)).toEqual(['SU', 'STS']);
    // And which one actually decided.
    expect(row.score_result_type).toBe('STS');
    expect(row.score_value).toBe(620);
  });

  it('records the enquiry id for reconciliation against billing', () => {
    expect(buildAssessmentRow(approvedRun()).enq_id).toBe('ENQ-1000001');
  });

  it('stores declared income whether or not it moved the limit', () => {
    expect(buildAssessmentRow(approvedRun(8_000)).declared_income).toBe(8_000);
    expect(buildAssessmentRow(approvedRun(90_000)).declared_income).toBe(90_000);
  });

  it('records the band that actually priced it, not the score band', () => {
    // A thin-file affordability result downgrades a Low-risk applicant.
    const sd = gate(score.SCORE_SUCCESS_SU_SCORED_660);
    const resolution = resolveAffordability(
      parseAffordabilityResponse(afford.AFFORD_ERROR_209_NO_GMIP), 'low');
    if (resolution.kind !== 'ready') throw new Error('expected a resolution');
    const limit = calculateCreditLimit({
      band: resolution.band, prediction: resolution.prediction, declared: null });

    const row = buildAssessmentRow(base({ scoreDecision: sd, resolution, limit }));

    expect(row.scorecard_band).toBe('thin_file');
    expect(row.thin_file_reason).toBe('no_gmip');
    expect(row.final_limit).toBe(1_000);
  });

  it('records the trigger so re-assessments are distinguishable', () => {
    for (const trigger of ['signup', 'staleness', 'increase_request', 'admin'] as const) {
      expect(buildAssessmentRow(base({ trigger })).trigger).toBe(trigger);
    }
  });

  it('carries the ID hash so a decline is findable after a re-registration', () => {
    expect(buildAssessmentRow(base({ saIdLookupHash: 'hash-abc' })).sa_id_lookup_hash)
      .toBe('hash-abc');
  });
});

// ─── The profile update ─────────────────────────────────────────────────

describe('profileUpdateFor', () => {
  it('an approval sets the limit and clears any old cooldown', () => {
    const update = profileUpdateFor(buildAssessmentRow(approvedRun()), 'assess-1', NOW);

    expect(update.approved_credit_limit).toBe(10_000);
    expect(update.credit_assessment_status).toBe('active');
    expect(update.credit_check_status).toBe('passed');
    expect(update.credit_decline_cooldown_until).toBeNull();
    expect(update.current_credit_assessment_id).toBe('assess-1');
    expect(update.credit_check_completed_at).toBe(NOW.toISOString());
  });

  it('a decline sets a cooldown and clears any stale limit', () => {
    const row = buildAssessmentRow(base({ scoreDecision: gate(score.SCORE_SUCCESS_SU_VERY_HIGH) }));
    const update = profileUpdateFor(row, 'assess-2', NOW);

    expect(update.credit_assessment_status).toBe('declined');
    expect(update.approved_credit_limit).toBeNull();
    expect(update.credit_decline_cooldown_until).toBe('2026-12-03T12:00:00.000Z');
  });

  it('a PENDING assessment sets no cooldown and clears no limit', () => {
    // The whole point of keeping pending distinct: a patient we could not
    // assess must not be locked out for three months because a SOAP
    // endpoint was briefly unavailable, and must not lose a limit they
    // already had.
    const row = buildAssessmentRow(base({ scoreDecision: gate(score.SCORE_SOAP_FAULT_500) }));
    const update = profileUpdateFor(row, 'assess-3', NOW);

    expect(update.credit_assessment_status).toBe('pending');
    expect(update).not.toHaveProperty('credit_decline_cooldown_until');
    expect(update).not.toHaveProperty('approved_credit_limit');
    expect(update.credit_check_status).toBe('pending');
  });

  it('a pending assessment does not mark the onboarding step failed', () => {
    const row = buildAssessmentRow(base({ scoreDecision: gate(score.SCORE_ERROR_107_BAD_CREDENTIALS) }));
    const update = profileUpdateFor(row, 'assess-4', NOW);
    expect(update.credit_check_status).not.toBe('failed');
  });

  it('always points the profile at the assessment that produced it', () => {
    for (const xml of [
      score.SCORE_SUCCESS_SU_SCORED_660,
      score.SCORE_SUCCESS_SU_VERY_HIGH,
      score.SCORE_SOAP_FAULT_500,
    ]) {
      const update = profileUpdateFor(
        buildAssessmentRow(base({ scoreDecision: gate(xml) })), 'assess-x', NOW);
      expect(update.current_credit_assessment_id).toBe('assess-x');
    }
  });
});
