// ─── Datanamix FaceTec Server SDK client ───────────────────────────────
//
// Thin wrapper over Datanamix's hosted FaceTec Server SDK
// (face.datanamix.com/v9 — Core Server SDK 9.7.25, confirmed via a live
// /session-token response in their OpenAPI spec). Mirrors the
// bounded-fetch discipline of lib/sms/smsportal.ts and lib/email/resend.ts:
// short AbortController timeout, never a thrown rejection, Basic Auth
// credentials read at call time (not import time) so a missing var
// doesn't crash the build.
//
// Required env vars:
//   FACETEC_API_BASE_URL   — optional, defaults to https://face.datanamix.com/v9
//   FACETEC_API_USERNAME   — Basic Auth username issued by Datanamix
//   FACETEC_API_PASSWORD   — Basic Auth password issued by Datanamix
//
// Two families of endpoint:
//
//   • "Licenses" (device-license-key, public-face-map-encryption-key,
//     production-keys) — no X-User-Agent required. These are the
//     parameters the BROWSER SDK needs at init time. They change rarely
//     (production-keys carries an expiryDate), so
//     getFaceTecBrowserSdkKeys() caches the combined result in memory.
//
//   • "Services" (session-token, liveness-3d, …) — REQUIRE an
//     X-User-Agent header. Per FaceTec's Session Tokens Guide this must
//     be the exact string the Device SDK itself generates for the
//     session — forwarded here verbatim, never synthesized server-side.

export type DatanamixOk<T>  = { ok: true } & T;
export type DatanamixErr    = { ok: false; error: string };
export type DatanamixResult<T> = DatanamixOk<T> | DatanamixErr;

const DEFAULT_BASE_URL     = 'https://face.datanamix.com/v9';
export const FACETEC_FETCH_TIMEOUT_MS = 15_000;
const KEYS_CACHE_TTL_MS    = 30 * 60_000;

function baseUrl(): string {
  return process.env.FACETEC_API_BASE_URL || DEFAULT_BASE_URL;
}

function authHeader(): string | null {
  const user = process.env.FACETEC_API_USERNAME;
  const pass = process.env.FACETEC_API_PASSWORD;
  if (!user || !pass) return null;
  // Basic auth: base64("USERNAME:PASSWORD"). Buffer.from is the standard
  // server-side path; this file is server-only (no 'use client').
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

let warnedMissingCreds = false;
function missingCredsWarningOnce(): void {
  if (warnedMissingCreds) return;
  warnedMissingCreds = true;
  console.warn(
    '[facetec] FACETEC_API_USERNAME / FACETEC_API_PASSWORD missing — '
    + 'Datanamix calls are a documented no-op. Set both env vars to enable.',
  );
}

type RawResult =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; error: string };

async function datanamixFetch(
  path: string,
  opts: { method?: string; body?: unknown; xUserAgent?: string } = {},
): Promise<RawResult> {
  const auth = authHeader();
  if (!auth) {
    missingCredsWarningOnce();
    return { ok: false, error: 'facetec_not_configured' };
  }

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), FACETEC_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method:  opts.method ?? 'GET',
      signal:  controller.signal,
      headers: {
        'Authorization': auth,
        'Accept':        'application/json',
        ...(opts.body       ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.xUserAgent ? { 'X-User-Agent': opts.xUserAgent }    : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    const json = await res.json().catch(() => null) as Record<string, unknown> | null;

    if (!res.ok || json === null) {
      console.warn('[facetec] Datanamix non-2xx or unparseable body', { path, status: res.status });
      return { ok: false, error: `facetec_provider_${res.status}` };
    }
    if (json.Status === 'Failure') {
      console.warn('[facetec] Datanamix returned Status:Failure', { path, error: json.Error });
      return { ok: false, error: 'facetec_auth_failed' };
    }
    return { ok: true, json };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      console.warn('[facetec] Datanamix timeout', { path });
      return { ok: false, error: 'facetec_timeout' };
    }
    console.warn('[facetec] Datanamix fetch failed', { path, message: (err as Error).message });
    return { ok: false, error: 'facetec_network' };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Browser SDK init parameters (device key, public key, production key) ──

export type FaceTecBrowserSdkKeys = {
  deviceKeyIdentifier:        string;
  publicFaceMapEncryptionKey: string;
  productionKeyText:          string;
};

let cachedKeys: { value: FaceTecBrowserSdkKeys; expiresAt: number } | null = null;

/**
 * Fetches (and caches for KEYS_CACHE_TTL_MS) the three parameters the
 * FaceTec Browser SDK needs to initialize: the Device Key Identifier, the
 * public FaceMap encryption key, and the production key text. None of
 * these are secret to a browser — FaceTec's own architecture ships them
 * to the client — but they're fetched server-side because the ONLY
 * credential able to retrieve them (Datanamix Basic Auth) must never
 * reach the browser.
 */
export async function getFaceTecBrowserSdkKeys(): Promise<DatanamixResult<{ data: FaceTecBrowserSdkKeys }>> {
  if (cachedKeys && cachedKeys.expiresAt > Date.now()) {
    return { ok: true, data: cachedKeys.value };
  }

  const [deviceRes, publicKeyRes, prodRes] = await Promise.all([
    datanamixFetch('/device-license-key'),
    datanamixFetch('/public-face-map-encryption-key'),
    datanamixFetch('/production-keys'),
  ]);

  if (!deviceRes.ok)    return deviceRes;
  if (!publicKeyRes.ok) return publicKeyRes;
  if (!prodRes.ok)      return prodRes;

  const deviceKeyIdentifier        = deviceRes.json.DeviceLicenseKey as string | undefined;
  const publicFaceMapEncryptionKey = publicKeyRes.json.PublicFaceMapEncryptionKey as string | undefined;
  const productionKeys             = prodRes.json.ProductionKeys as { key?: string } | undefined;
  const productionKeyText          = productionKeys?.key;

  if (!deviceKeyIdentifier || !publicFaceMapEncryptionKey || !productionKeyText) {
    console.warn('[facetec] Datanamix license response missing an expected field');
    return { ok: false, error: 'facetec_bad_license_response' };
  }

  const value: FaceTecBrowserSdkKeys = { deviceKeyIdentifier, publicFaceMapEncryptionKey, productionKeyText };
  cachedKeys = { value, expiresAt: Date.now() + KEYS_CACHE_TTL_MS };
  return { ok: true, data: value };
}

// ─── Session token ──────────────────────────────────────────────────────

/**
 * GET /session-token — mints the encrypted Session Token the Browser SDK
 * needs to launch a Liveness Check. xUserAgent must be the string the
 * Device SDK generated for this attempt (see module banner); it is
 * forwarded verbatim, never generated here.
 */
export async function getFaceTecSessionToken(xUserAgent: string): Promise<DatanamixResult<{ sessionToken: string }>> {
  const res = await datanamixFetch('/session-token', { xUserAgent });
  if (!res.ok) return res;

  const sessionToken = res.json.sessionToken as string | undefined;
  if (res.json.success !== true || !sessionToken) {
    console.warn('[facetec] session-token call did not return a usable token');
    return { ok: false, error: 'facetec_session_token_failed' };
  }
  return { ok: true, sessionToken };
}

// ─── 3D Liveness Check ──────────────────────────────────────────────────

export type LivenessScanInput = {
  faceScan:                   string;
  auditTrailImage:            string;
  lowQualityAuditTrailImage:  string;
  xUserAgent:                 string;
};

/**
 * POST /liveness-3d — the SINGLE call that decides pass/fail for the
 * onboarding liveness step. success:false covers both a rejected scan
 * (spoof / no live face detected) and a malformed capture; either way the
 * caller treats it as "not verified, try again".
 */
export async function postLiveness3d(input: LivenessScanInput): Promise<DatanamixResult<{ success: boolean }>> {
  const res = await datanamixFetch('/liveness-3d', {
    method:     'POST',
    xUserAgent: input.xUserAgent,
    body: {
      faceScan:                  input.faceScan,
      auditTrailImage:           input.auditTrailImage,
      lowQualityAuditTrailImage: input.lowQualityAuditTrailImage,
    },
  });
  if (!res.ok) return res;
  return { ok: true, success: res.json.success === true };
}
