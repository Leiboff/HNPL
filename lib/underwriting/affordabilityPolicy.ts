// ═══════════════════════════════════════════════════════════════════════
//  The affordability seam — where the real credit check lands
// ═══════════════════════════════════════════════════════════════════════
//
// This replaces `stubAffordabilityPolicy`, which unconditionally granted a
// fixed R5,000 to every applicant. That stub was clearly labelled, but a
// label is not a control: it was the reason the fraud chain in audit S-07
// was worth running at all, because every synthetic identity that reached
// this point was handed real spendable credit for free.
//
// It is gone. Nothing in this codebase grants a credit limit any more.
//
// ─── WHY THIS FILE EXISTS RATHER THAN NOTHING AT ALL ────────────────────
//
// Deleting the stub outright would have left `runCreditCheck` with no
// decision to make and the column it wrote to set by nobody — and the next
// person wiring the real bureau integration would have had to rediscover
// where it plugs in. This is that place, and it is deliberately the ONLY
// place: `profiles.approved_credit_limit` is written from exactly one call
// site (lib/onboarding/actions.ts's runCreditCheck), which writes whatever
// this function returns and nothing else.
//
// ─── WHY IT REFUSES RATHER THAN GUESSING ────────────────────────────────
//
// The obvious shortcut is to compute a limit from `profiles.salary_amount`,
// which is already collected. That would be worse than the stub, not
// better.
//
// An affordability assessment is a REGULATED act under the National Credit
// Act. A formula invented in a source file, with no policy document and no
// compliance sign-off behind it, would produce a number that LOOKS like
// underwriting — and unlike the stub, whose banner shouted that it was
// scaffolding, it would be believed. A control that quietly manufactures
// regulatory exposure is not an improvement on one that loudly does
// nothing.
//
// So until the real check is configured, this returns `unavailable`. The
// consequence is honest and visible: no applicant receives a limit, the
// approved-balance card renders nothing, and any attempt to accept a plan
// is refused with copy that says an assessment is pending. Nobody is told
// they have credit they do not have.
//
// ─── WHAT THE REAL INTEGRATION HAS TO DO ────────────────────────────────
//
// Replace the body of `assessAffordability` — the signature and the return
// type are the contract, and the caller already persists whatever comes
// back. It should:
//
//   • take the applicant's verified identity and declared income (both
//     already on the profile by the time this runs);
//   • perform the bureau enquiry and the NCA affordability calculation;
//   • return `approved` with a limit in CENTS, or `declined`, or
//     `unavailable` when the provider could not be reached.
//
// `unavailable` and `declined` are deliberately different outcomes. A
// provider outage must not be recorded as a refusal on someone's file.

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

/** True when a real policy is wired up. Read by the UI and by tests so the
 *  interim state is a stated fact rather than something inferred from a
 *  refusal. */
export function affordabilityPolicyConfigured(): boolean {
  return false;
}

/**
 * Assess an applicant's affordability.
 *
 * Returns `unavailable` until the real credit check is configured. See the
 * header for why this refuses rather than computing something from the
 * declared salary.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function assessAffordability(input: AffordabilityInput): AffordabilityDecision {
  return {
    outcome: 'unavailable',
    reason: 'policy_not_configured',
  };
}
