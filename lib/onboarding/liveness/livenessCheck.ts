// ─── Liveness check — FaceTec Browser SDK (blob-relay generation) ──────
//
// Replaces the pre-launch stub. This is the SINGLE SOURCE OF TRUTH for
// the liveness pass/fail decision — runLiveness() (lib/onboarding/actions.ts)
// gates on this and nothing else.
//
// Unlike the classic FaceTec integration (explicit FaceScan + audit-trail
// fields posted to a /liveness-3d-style endpoint), the v10.1.9 Browser
// SDK's only entry point — initializeWithSessionRequest — never exposes
// the raw biometric data to our code at all: every round trip is an
// opaque, encrypted blob relayed blind through lib/facetec/relay.ts (see
// its banner). The verification itself happens entirely inside FaceTec's
// own cloud infrastructure. The one signal our code DOES get is the
// FaceTecSessionStatus the Device SDK reports when the session ends —
// per FaceTec's own sample app (SampleAppController.demonstrateHandlingFaceTecExit),
// SessionCompleted is the sanctioned way to read the outcome in this SDK
// generation: FaceTec's core guarantee is that Completed is never
// reported unless what the session was configured to check actually
// passed.
//
// KNOWN LIMITATION, not silently absorbed: sessionCompleted here is
// reported by the CLIENT (LivenessStepClient.tsx, from FaceTecSessionResult.status),
// so a tampered/compromised browser could in principle claim success
// without a real check. lib/facetec/relay.ts already threads the raw
// `result` object from each of FaceTec's own relay responses back to the
// caller for exactly this reason — once its field shape is confirmed
// with FaceTec (it isn't documented anywhere available to this
// codebase), tighten checkLiveness to gate on THAT server-verified
// signal instead of/in addition to the client-reported status.

export type LivenessResult = 'pass' | 'fail';

export function checkLiveness(input: { sessionCompleted: boolean }): LivenessResult {
  return input.sessionCompleted ? 'pass' : 'fail';
}
