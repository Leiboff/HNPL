// ═══════════════════════════════════════════════════════════════════════
//  STUB — hardcoded R5,000 test grant. NOT a real affordability check.
// ═══════════════════════════════════════════════════════════════════════
//
//  ⚠️  THIS IS TEST SCAFFOLDING, NOT UNDERWRITING.  ⚠️
//
//   • NO credit check performed — NO credit bureau is queried.
//   • NO income / expense inputs are collected or computed.
//   • This is NOT an NCA affordability assessment and performs no
//     assessment of any kind.
//   • It unconditionally approves a fixed R5,000 test limit.
//
//  REPLACE THIS ENTIRE MODULE with real underwriting + compliance
//  sign-off before ANY real customer is onboarded. Until then the
//  granted balance is a test balance only (see TestBalanceNotice).
//
//  This module is the SINGLE SOURCE OF TRUTH for the test limit. The
//  amount (500_000 cents = R5,000.00) is defined here and NOWHERE else —
//  the rest of the app reads the granted `approved_credit_limit` off the
//  account, never this literal. Changing the return value here changes
//  the whole app's behaviour with no other edit (see runCreditCheck).

export type AffordabilityDecision = {
  /** Whether the applicant is approved for a limit. */
  approved: boolean;
  /** Approved limit in cents. Zero when not approved. */
  limitCents: number;
};

/** R5,000.00, expressed in cents. The one place this number exists. */
const STUB_LIMIT_CENTS = 500_000;

/**
 * STUB affordability policy — always approves the fixed test limit.
 *
 * Takes no inputs on purpose: there is nothing to assess. A real policy
 * would take the applicant's verified income/obligations and return a
 * computed decision; swapping this function's body (or the whole module)
 * for that real policy is the only change needed to make the app use real
 * underwriting — the caller already persists whatever limit is returned.
 */
export function stubAffordabilityPolicy(): AffordabilityDecision {
  return { approved: true, limitCents: STUB_LIMIT_CENTS };
}
