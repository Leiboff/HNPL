// ─── Identity photo provider selection ──────────────────────────────────
//
// Two registry sources can produce the portrait we face-match against:
//
//   didit_dha  — Didit's live Department of Home Affairs query
//                (lib/didit/dha.ts). Authoritative and current, ~$1.10
//                per conclusive lookup.
//
//   datanamix  — Datanamix Profile Plus, a credit-bureau COPY of Home
//                Affairs data (lib/datanamix/client.ts). ~R4.50, but
//                observed live as up to 90 days stale (LastUpdated
//                "Less than 90 days", LastUpdatedIndicator "3").
//
// Both return the same RouteDecision, so everything downstream — session
// creation, the webhook, the decision table — is provider-agnostic. This
// module is the only place that knows which one is in play.
//
// ── ACCEPTED RISK ───────────────────────────────────────────────────
// The datanamix provider's staleness window has been reviewed and
// accepted as a product decision: an ID blocked or a death registered
// within the last ~90 days may still read as clean. The mitigation is
// auditability, not prevention — identity_source_offline and
// identity_source_last_updated (migration 0104) record what the bureau
// itself declared at the moment of each decision, so any later dispute
// can establish exactly how current the data was. Do not "fix" this by
// silently routing stale results to review; that reverses a decision
// that was made deliberately.

import { resolveIdentityRoute } from './dhaVerification';
import { resolveDatanamixRoute } from './datanamixVerification';
import type { RouteDecision } from './dhaVerification';

export type IdentityProvider = 'didit_dha' | 'datanamix';

/**
 * Which provider to use. Defaults to didit_dha — the live registry is
 * the safe default, so a missing or misspelt env var degrades to the
 * MORE authoritative source, never the cheaper/staler one.
 */
export function identityProvider(): IdentityProvider {
  return process.env.IDENTITY_PHOTO_PROVIDER === 'datanamix' ? 'datanamix' : 'didit_dha';
}

/**
 * Resolve the identity route using the configured provider.
 * Signature-identical to both underlying resolvers.
 */
export async function resolveIdentityRouteForProvider(
  nationalId: string,
  vendorData: string,
): Promise<{ provider: IdentityProvider; route: RouteDecision }> {
  const provider = identityProvider();
  const route = provider === 'datanamix'
    ? await resolveDatanamixRoute(nationalId, vendorData)
    : await resolveIdentityRoute(nationalId, vendorData);
  return { provider, route };
}
