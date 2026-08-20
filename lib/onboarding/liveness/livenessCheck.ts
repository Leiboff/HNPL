// ─── Liveness check — Datanamix FaceTec 3D Liveness ────────────────────
//
// Replaces the pre-launch stub. This is the SINGLE SOURCE OF TRUTH for
// the liveness pass/fail decision — runLiveness() (lib/onboarding/actions.ts)
// gates on this and nothing else, so a provider outage or a genuine
// spoof/no-face result surfaces as 'fail' the same way.
//
// Input is exactly what the FaceTec Browser SDK's FaceScanProcessor hands
// back after a completed 3D Liveness Check session: the base64 FaceScan,
// the two audit-trail images, and the X-User-Agent string the Device SDK
// generated for that session. That last one MUST be forwarded verbatim —
// see the banner in lib/facetec/datanamixClient.ts for why it can't be
// synthesized server-side.

import { postLiveness3d, type LivenessScanInput } from '@/lib/facetec/datanamixClient';

export type { LivenessScanInput };
export type LivenessResult = 'pass' | 'fail';

export async function checkLiveness(input: LivenessScanInput): Promise<LivenessResult> {
  const result = await postLiveness3d(input);
  if (!result.ok) {
    // Provider unreachable / misconfigured / rejected the request outright.
    // Treated identically to a failed check — never silently pass.
    console.warn('[liveness] postLiveness3d failed', { error: result.error });
    return 'fail';
  }
  return result.success ? 'pass' : 'fail';
}
