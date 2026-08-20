// ─── FaceTec Browser SDK client config ──────────────────────────────────
//
// The FaceTec Browser SDK v10.1.9's only entry point,
// initializeWithSessionRequest(deviceKeyIdentifier, sessionRequestProcessor,
// callback), takes exactly one credential client-side: the Device Key
// Identifier (issued at dev.facetec.com/account via FaceTec's
// Configuration Wizard). Unlike the older "classic" integration
// (initializeInProductionMode), this SDK generation does NOT take a
// public FaceScan encryption key or production key text as init
// parameters — those don't apply here; licensing/domain verification
// happens entirely server-side, inside FaceTec's own infrastructure,
// as part of the blob relay (see lib/facetec/relay.ts). Still read
// server-side and handed to the client only through getFaceTecInitParams()
// (lib/onboarding/actions.ts) so nothing is hardcoded into the bundle.
//
// Required env var:
//   FACETEC_DEVICE_KEY_IDENTIFIER

export type FaceTecBrowserSdkConfig = {
  deviceKeyIdentifier: string;
};

export type FaceTecBrowserSdkConfigResult =
  | { ok: true; data: FaceTecBrowserSdkConfig }
  | { ok: false; error: string };

let warnedMissingConfig = false;

export function getFaceTecBrowserSdkConfig(): FaceTecBrowserSdkConfigResult {
  const deviceKeyIdentifier = process.env.FACETEC_DEVICE_KEY_IDENTIFIER;

  if (!deviceKeyIdentifier) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn(
        '[facetec] FACETEC_DEVICE_KEY_IDENTIFIER missing — the liveness step '
        + 'is a documented no-op until it is set.',
      );
    }
    return { ok: false, error: 'facetec_not_configured' };
  }

  return { ok: true, data: { deviceKeyIdentifier } };
}
