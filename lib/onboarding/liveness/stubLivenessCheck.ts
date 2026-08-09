// ═══════════════════════════════════════════════════════════════════════
//  STUB — always passes. NOT a real liveness / KYC check.
// ═══════════════════════════════════════════════════════════════════════
//
//  ⚠️  THIS IS TEST SCAFFOLDING, NOT IDENTITY VERIFICATION.  ⚠️
//
//   • NO liveness / KYC provider is called.
//   • NO camera, capture, or biometric comparison happens.
//   • It unconditionally returns "pass".
//
//  REPLACE THIS ENTIRE MODULE with a real liveness integration before
//  ANY real customer is onboarded. Until then no identity check of any
//  kind has occurred — do not describe it to the user as one.
//
//  This is the SINGLE SOURCE OF TRUTH for the liveness pass/fail
//  decision. Changing the return value here changes the whole flow with
//  no other edit (see runLiveness): return 'fail' and the onboarding step
//  blocks instead of advancing.

export type LivenessResult = 'pass' | 'fail';

/**
 * STUB liveness check — always passes. Takes no inputs: there is nothing
 * to verify. A real check would consume a capture/session token and
 * return the provider's verdict; swapping this function's body (or the
 * whole module) is the only change needed to wire the real provider — the
 * caller already gates on the returned result.
 */
export function stubLivenessCheck(): LivenessResult {
  return 'pass';
}
