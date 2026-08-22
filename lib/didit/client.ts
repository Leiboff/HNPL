// SERVER-ONLY. Never import in a client component.
//
// Didit verification-session client (v3 Sessions API).
//
// Env vars:
//   DIDIT_API_KEY       — application API key (Console → Applications).
//                          Sent as `x-api-key` on every call.
//   DIDIT_WORKFLOW_ID    — the published workflow this app's sessions use
//                          (OCR + LIVENESS + FACE_MATCH [+ AML]).
//   DIDIT_APP_BASE_URL   — this app's public origin (e.g.
//                          https://www.betternow.co.za), used to build the
//                          `callback` URL Didit redirects back to.
//
// Auth failures on this surface are always HTTP 403 with a generic body
// (never 401) — see docs.didit.me/integration/webhooks. There's no
// machine-readable discriminator for "missing" vs "expired" vs "wrong
// app", so we surface the raw status + body and let the caller treat any
// non-2xx as "verification unavailable right now".

import type { DiditCreateSessionResponse } from './types';

const DIDIT_API_BASE = 'https://verification.didit.me';
const DEFAULT_TIMEOUT_MS = 8_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in environment variables.`);
  return v;
}

export type CreateDiditSessionInput = {
  /** Our internal user id — profiles.id. Echoed back on every webhook. */
  vendorData: string;
  /** Absolute URL Didit redirects the user to after the hosted flow. */
  callback:   string;
};

export async function createDiditSession(
  input: CreateDiditSessionInput,
): Promise<DiditCreateSessionResponse> {
  const apiKey     = requireEnv('DIDIT_API_KEY');
  const workflowId = requireEnv('DIDIT_WORKFLOW_ID');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${DIDIT_API_BASE}/v3/session/`, {
      method: 'POST',
      headers: {
        'x-api-key':    apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workflow_id: workflowId,
        vendor_data: input.vendorData,
        callback:    input.callback,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Didit session create failed: HTTP ${res.status} ${text.slice(0, 500)}`);
    }
    return (await res.json()) as DiditCreateSessionResponse;
  } finally {
    clearTimeout(timeout);
  }
}

/** Absolute base URL for this app, used to build the Didit `callback`. */
export function diditAppBaseUrl(): string {
  return requireEnv('DIDIT_APP_BASE_URL').replace(/\/$/, '');
}
