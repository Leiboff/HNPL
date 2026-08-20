// ─── FaceTec cloud relay ────────────────────────────────────────────────
//
// Server-side middleman between the FaceTec Browser SDK (v10.1.9 — its
// only entry point, initializeWithSessionRequest, speaks this "blob
// relay" generation) and FaceTec's own production processing API.
//
// Per FaceTec's own sample app (SampleAppNetworkingRequest.ts): the SDK
// must never call FaceTec's server directly from the browser in
// production. It posts an opaque, encrypted "request blob" to YOUR
// backend, and YOUR backend forwards it to FaceTec, then relays the
// encrypted "response blob" straight back. Neither this file nor the
// browser ever decrypts or reads the blob's contents — that happens
// entirely inside FaceTec's own infrastructure. This fires on EVERY
// round trip the SDK makes during a session — the initial handshake at
// initializeWithSessionRequest AND the actual capture submission during
// start3DLiveness — all funneled through this one relay.
//
// Required env vars (server-only, read at call time not import time):
//   FACETEC_RELAY_API_URL          — the production endpoint FaceTec issued you
//   FACETEC_RELAY_API_KEY          — the credential FaceTec issued for it
//   FACETEC_RELAY_AUTH_HEADER_NAME — optional, defaults to 'X-Api-Key'.
//                                    Change this if FaceTec told you to
//                                    send the credential a different way
//                                    (e.g. an Authorization: Bearer
//                                    header) — the exact scheme isn't in
//                                    any doc available to this codebase,
//                                    so it's a one-env-var fix rather
//                                    than a hardcoded guess.
//
// FaceTec's raw JSON response is `{ responseBlob, result? }` — result is
// an OPTIONAL plain object alongside the opaque blob (FaceTec's sample
// app uses it for one specific feature, "Official ID Photo"). It's
// returned here as-is (never assumed to have any particular shape) so
// callers can inspect it for audit/logging without this file guessing
// at field names it can't verify.

export type RelayResult =
  | { ok: true; responseBlob: string; result: Record<string, unknown> | null }
  | { ok: false; error: string };

const DEFAULT_AUTH_HEADER_NAME = 'X-Api-Key';
export const FACETEC_RELAY_TIMEOUT_MS = 15_000;

let warnedMissingConfig = false;

export async function relayFaceTecRequest(requestBlob: string): Promise<RelayResult> {
  const url       = process.env.FACETEC_RELAY_API_URL;
  const apiKey    = process.env.FACETEC_RELAY_API_KEY;
  const headerName = process.env.FACETEC_RELAY_AUTH_HEADER_NAME || DEFAULT_AUTH_HEADER_NAME;

  if (!url || !apiKey) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn(
        '[facetec] FACETEC_RELAY_API_URL / FACETEC_RELAY_API_KEY missing — '
        + 'the relay is a documented no-op. Set both env vars to enable.',
      );
    }
    return { ok: false, error: 'facetec_relay_not_configured' };
  }

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), FACETEC_RELAY_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type': 'application/json',
        [headerName]:   apiKey,
      },
      body: JSON.stringify({ requestBlob }),
    });

    const json = await res.json().catch(() => null) as
      { responseBlob?: string; result?: Record<string, unknown> } | null;

    if (!res.ok || !json || typeof json.responseBlob !== 'string') {
      console.warn('[facetec] relay non-2xx or malformed response', { status: res.status });
      return { ok: false, error: `facetec_relay_${res.status}` };
    }

    return { ok: true, responseBlob: json.responseBlob, result: json.result ?? null };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      console.warn('[facetec] relay timeout');
      return { ok: false, error: 'facetec_relay_timeout' };
    }
    console.warn('[facetec] relay fetch failed', { message: (err as Error).message });
    return { ok: false, error: 'facetec_relay_network' };
  } finally {
    clearTimeout(timeoutId);
  }
}
