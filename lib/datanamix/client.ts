// SERVER-ONLY. Never import in a client component.
//
// Datanamix Profile Plus ID + Photo lookup — the bureau-sourced
// alternative to Didit's live DHA query (lib/didit/dha.ts). Same
// contract: called BEFORE any Didit session is created, and its outcome
// is turned into a route by lib/onboarding/datanamixVerification.ts.
//
// Two differences from the Didit client that matter:
//
//   1. AUTH is OAuth2 client-credentials, not a static key. Tokens are
//      cached in-process until shortly before expiry. SANDBOX needs no
//      auth at all (per Datanamix's spec, any Authorization header is
//      ignored there) — so sandbox works with no credentials set.
//
//   2. 4xx DOES NOT automatically mean "our integration is broken".
//      Datanamix returns ResponseCode 6 (validation error) for a
//      malformed *applicant* ID, which is a legitimate decline. So the
//      transport layer here classifies on the payload's ResponseCode
//      whenever one is present, and only treats a status as an
//      integration error when the payload gives us nothing to go on.
//
// The core invariant is unchanged from the DHA path: the OCR fallback
// triggers ONLY on the registry failing to answer — never on it
// answering "this identity is not in the register".

import type { DatanamixProfilePlusResponse } from './types';

const DATANAMIX_API_BASE = 'https://api.datanamix.com';
const LOOKUP_PATH = '/v1/id-verification/ProfilePlusIDVerificationAndPhoto';
const TOKEN_PATH  = '/v1/oauth/token';
const DEFAULT_TIMEOUT_MS = 12_000; // bureau lookups return a ~1.9MB photo

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in environment variables.`);
  return v;
}

/** True when we should talk to the LIVE environment. */
export function datanamixIsLive(): boolean {
  return (process.env.DATANAMIX_ENVIRONMENT ?? 'SANDBOX').toUpperCase() === 'LIVE';
}

export type DatanamixLookupInput = {
  /** Cleaned, already-validated 13-digit SA ID. */
  nationalId: string;
  /** Our internal user id — sent as ClientReference. */
  vendorData: string;
};

export type DatanamixLookupOutcome =
  /** A real Datanamix response. Routing decides what it means. */
  | { kind: 'success'; data: DatanamixProfilePlusResponse; httpStatus: number }
  /** Timeout, connection failure, 5xx, or ResponseCode 5/7. May fall back. */
  | { kind: 'unavailable'; detail: string }
  /** Our request or credentials were rejected. Never falls back. */
  | { kind: 'request_error'; status: number; detail: string };

// ── OAuth token cache ──────────────────────────────────────────────────
// Module-scoped, so it survives across requests in a warm serverless
// instance and costs nothing in a cold one. Refreshed 60s before expiry
// to avoid racing the boundary.

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Exported for tests only. */
export function __resetDatanamixTokenCache(): void {
  cachedToken = null;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     requireEnv('DATANAMIX_CLIENT_ID'),
    client_secret: requireEnv('DATANAMIX_CLIENT_SECRET'),
  });

  const res = await fetch(`${DATANAMIX_API_BASE}${TOKEN_PATH}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal:  AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Datanamix token request failed: HTTP ${res.status}`);

  let json: { access_token?: string; expires_in?: number };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error('Datanamix token response was not JSON.');
  }
  if (!json.access_token) throw new Error('Datanamix token response had no access_token.');

  // Default to 5 min if expires_in is absent — short, so a wrong guess
  // costs an extra token call rather than 401s on every lookup.
  const ttlSeconds = typeof json.expires_in === 'number' && json.expires_in > 60
    ? json.expires_in
    : 300;
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (ttlSeconds - 60) * 1000 };
  return cachedToken.value;
}

export async function callDatanamixProfilePlus(
  input: DatanamixLookupInput,
): Promise<DatanamixLookupOutcome> {
  const live = datanamixIsLive();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (live) {
    try {
      headers.Authorization = `Bearer ${await getAccessToken()}`;
    } catch (err) {
      // Missing/invalid credentials are a configuration problem, not the
      // bureau being down. Same operational answer as the DHA path takes
      // for a missing API key (fall back rather than block the patient),
      // but the detail string is deliberately distinct so the path-split
      // alerting can tell a misconfiguration from a real outage.
      return {
        kind:   'unavailable',
        detail: `datanamix_auth_unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  let res: Response;
  try {
    res = await fetch(`${DATANAMIX_API_BASE}${LOOKUP_PATH}`, {
      method:  'POST',
      headers,
      body: JSON.stringify({
        IDNumber:        input.nationalId,
        OutputFormat:    'JSON',
        ClientReference: input.vendorData,
        EnvironmentType: live ? 'LIVE' : 'SANDBOX',
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // Timeout or connection failure — the bureau (or the path to it) is
    // unreachable. The only transport outcome that may reach OCR.
    return {
      kind:   'unavailable',
      detail: `datanamix_transport: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = await res.text();

  let data: DatanamixProfilePlusResponse | null = null;
  try {
    data = JSON.parse(text) as DatanamixProfilePlusResponse;
  } catch {
    data = null;
  }

  // A parseable payload is authoritative over the HTTP status: their 404
  // means BOTH "product not activated" and ResponseCode 4 "no record
  // found", so status alone cannot distinguish a misconfiguration from a
  // genuine absent identity. Hand the payload to the routing table and
  // let it decide — including for 4xx.
  if (data && typeof data.ResponseCode === 'number') {
    return { kind: 'success', data, httpStatus: res.status };
  }

  if (res.status >= 500) {
    return { kind: 'unavailable', detail: `datanamix_http_${res.status}` };
  }

  // No usable payload and a non-5xx status — we have nothing to route on.
  // Treated as an integration error: never falls back, never approves.
  return {
    kind:   'request_error',
    status: res.status,
    detail: `datanamix_unparseable_response: ${text.slice(0, 200)}`,
  };
}
