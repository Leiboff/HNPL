import { assessAtSignup, type Assessment, type AssessmentDeps } from '@/lib/experian/assessAtSignup';

// ═══════════════════════════════════════════════════════════════════════
//  The affordability seam — where the real credit check lands
// ═══════════════════════════════════════════════════════════════════════
//
// This replaced `stubAffordabilityPolicy`, which unconditionally granted a
// fixed R5,000 to every applicant. That stub was clearly labelled, but a
// label is not a control: it was the reason the fraud chain in audit S-07
// was worth running at all, because every synthetic identity that reached
// this point was handed real spendable credit for free.
//
// It is gone. Nothing in this codebase grants a credit limit any more, and
// that is STILL TRUE after the bureau integration below — see "why nothing
// can be approved yet".
//
// ─── WHAT CHANGED, AND WHAT DID NOT ────────────────────────────────────
//
// The bureau enquiry is now real. `assessAtSignup` performs an Experian
// Person Get Score call behind a consent gate, a local ID validation, a
// 45-day cache and a double-billing guard, and returns a risk EXPOSURE keyed
// on scorecard and band.
//
// What has not changed is that no applicant receives a limit. Two independent
// reasons, either of which alone is sufficient:
//
//   1. Every value in RISK_EXPOSURE_CENTS is null except band 1, which is
//      zero. Calibrating them needs Experian's bad-rate table by band, per
//      scorecard, and it has not been supplied. An uncalibrated band refers.
//   2. Even a calibrated exposure is not a credit limit. Exposure becomes a
//      purchase allowance through a business rule that is NOT implemented in
//      this repository. See the `approved` branch below, which is the one
//      place that would otherwise quietly invent the conversion.
//
// Both are deliberate. Inventing either number would produce something that
// LOOKS like underwriting, and unlike the stub — whose banner shouted that it
// was scaffolding — it would be believed.
//
// ─── WHY IT STILL REFUSES RATHER THAN GUESSING ─────────────────────────
//
// The obvious shortcut is to compute a limit from `profiles.salary_amount`,
// which is already collected. That would be worse than the stub, not better.
//
// An affordability assessment is a REGULATED act under the National Credit
// Act. A formula invented in a source file, with no policy document and no
// compliance sign-off behind it, would produce a number that LOOKS like
// underwriting. A control that quietly manufactures regulatory exposure is
// not an improvement on one that loudly does nothing.
//
// The consequence stays honest and visible: no applicant receives a limit,
// the approved-balance card renders nothing, and any attempt to accept a plan
// is refused with copy that says an assessment is pending. Nobody is told
// they have credit they do not have.
//
// ─── unavailable IS NOT declined ───────────────────────────────────────
//
// `unavailable` and `declined` are deliberately different outcomes, and the
// bureau mapping below preserves that distinction rather than collapsing it.
// A provider outage, an unconfigured policy, or a referral for manual review
// must not be recorded as a refusal on someone's file. Only a bureau HARD
// DECLINE — deceased, sequestrated, under debt review, fraud — is a decision
// about the applicant, and only that maps to `declined`.

/** Everything a real policy is given. Present on the profile before
 *  `runCreditCheck` is reachable — the onboarding state model requires the
 *  salary and identity steps first. */
export type AffordabilityInput = {
  /** profiles.id */
  accountId: string;
  /** Declared gross monthly income, in rands. */
  salaryAmountRands: number | null;
  /** Day of the month the applicant is paid. */
  salaryDay: number | null;
  /** True once the Didit webhook has written both sa_id_number and
   *  liveness_verified_at. A policy must not assess an unverified identity. */
  identityVerified: boolean;
  /**
   * The verified SA ID in PLAINTEXT, decrypted by the caller from
   * profiles.sa_id_number.
   *
   * The bureau enquiry cannot be made without it, and it deliberately comes
   * from the column the Didit webhook wrote rather than from anything the
   * applicant typed — there is exactly one identity-capture path and this is
   * not a second one.
   */
  saIdNumber: string | null;
};

export type AffordabilityDecision =
  /** A limit was assessed and granted. `limitCents` is what gets written to
   *  profiles.approved_credit_limit (as rands). */
  | { outcome: 'approved'; limitCents: number }
  /** Assessed, and no credit is offered. A decision on the applicant's file. */
  | { outcome: 'declined'; reason: string }
  /** No decision was reached — the policy is not configured, or the provider
   *  could not be reached. NOT a refusal, and must never be recorded as one. */
  | { outcome: 'unavailable'; reason: string };

/**
 * True when a real policy is wired up END TO END.
 *
 * Still false, and honestly so. The bureau half is real, but a policy that
 * cannot convert an exposure into a limit cannot grant one, so reporting
 * "configured" here would be a claim the system cannot honour. It goes true
 * when RISK_EXPOSURE_CENTS is calibrated AND the exposure-to-allowance rule
 * exists — not when the Experian credentials are set.
 */
export function affordabilityPolicyConfigured(): boolean {
  return false;
}

/**
 * Assess an applicant's affordability.
 *
 * `deps` carries the bureau I/O — the consent predicate, the enquiry cache,
 * the attempt ledger and the Experian config. It is OPTIONAL, and omitting it
 * is what "the policy is not wired up" means: with no dependencies there is
 * no enquiry to make, and the answer is `unavailable`. That is the state
 * every caller outside `runCreditCheck` is in, and the state production is in
 * while ENABLE_CREDIT_CHECK is off.
 *
 * This function constructs no clients and opens no sockets. The caller owns
 * the service-role client, exactly as it owns the profile read.
 */
export async function assessAffordability(
  input: AffordabilityInput,
  deps?: AssessmentDeps,
): Promise<AffordabilityDecision> {
  if (!deps) {
    return { outcome: 'unavailable', reason: 'policy_not_configured' };
  }

  // A policy must not assess an unverified identity. Both of these are
  // upstream invariants — the onboarding state model puts the identity step
  // before this one — so reaching either is a routing bug, not an applicant
  // outcome, and neither may sit on a file as a refusal.
  if (!input.identityVerified) {
    return { outcome: 'unavailable', reason: 'identity_not_verified' };
  }
  if (!input.saIdNumber) {
    return { outcome: 'unavailable', reason: 'no_verified_id_on_file' };
  }

  const assessment = await assessAtSignup(input.accountId, input.saIdNumber, deps);
  return mapAssessment(assessment);
}

/**
 * Bureau outcome → affordability outcome.
 *
 * Exported for testing, because this mapping is where "fail closed" either
 * holds or silently stops holding, and it deserves to be exercised on every
 * branch without a database behind it.
 */
export function mapAssessment(assessment: Assessment): AffordabilityDecision {
  switch (assessment.decision) {
    case 'declined':
      // The only branch that is a decision ABOUT THE APPLICANT: a hard
      // decline on an identity-level flag, or a calibrated band worth zero.
      //
      // Reason CODES only, never descriptions. Confirmed against real data,
      // MI20 appeared on both a band-2 and a band-5 file and MI39 on 46% of a
      // 50-file sample including minimum-risk files — they describe the
      // largest drag on a score, not the basis of a decision. This string is
      // internal: runCreditCheck answers the patient with fixed copy and
      // never renders it.
      return {
        outcome: 'declined',
        reason: assessment.reasonCodes.length
          ? `bureau:${assessment.reasonCodes.join(',')}`
          : 'bureau:declined',
      };

    case 'referred':
      // A referral is the ABSENCE of a decision, not a refusal. Uncalibrated
      // bands, thin files, bureau disputes and unrecognised scorecards all
      // land here, and none of them may be written to a file as a decline.
      return { outcome: 'unavailable', reason: 'referred_for_manual_review' };

    case 'error':
      // Transport failure, config fault, or a -113/-114 on our own input.
      // Our problem, never the applicant's.
      return { outcome: 'unavailable', reason: 'bureau_unavailable' };

    case 'approved':
      // ─── THE MISSING BUSINESS RULE, AND WHY THIS REFUSES ─────────────
      //
      // The bureau has returned a calibrated risk EXPOSURE. That is not a
      // credit limit, and this function's contract is to return a limit.
      //
      // Exposure becomes a purchase allowance through a rule that does not
      // exist in this repository — not in this file, not in lib/finance.ts,
      // not anywhere. Multiplying by a factor remembered from a brief would
      // be exactly the invented-number failure the header refuses, and it
      // would be worse than the R5,000 stub because it would carry the
      // authority of a real bureau score.
      //
      // So this refuses, LOUDLY, and the refusal is the signal: populating
      // RISK_EXPOSURE_CENTS alone will NOT start approvals, and should not.
      // Whoever calibrates those numbers must also implement the
      // exposure-to-allowance conversion and the
      // min(risk, affordability, product max) clamp, with the NCA
      // affordability calculation beside them, and change this branch
      // deliberately.
      return { outcome: 'unavailable', reason: 'purchase_allowance_rule_not_implemented' };
  }
}
