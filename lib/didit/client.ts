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
  vendorData:    string;
  /** Absolute URL Didit redirects the user to after the hosted flow. */
  callback:      string;
  /** Explicit workflow override. Defaults to DIDIT_WORKFLOW_ID (OCR fallback). */
  workflowId?:   string;
  /** Base64 reference portrait. See createDhaFaceMatchSession for the DHA path. */
  portraitImage?: string;
};

async function postSession(body: Record<string, unknown>): Promise<DiditCreateSessionResponse> {
  const apiKey = requireEnv('DIDIT_API_KEY');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${DIDIT_API_BASE}/v3/session/`, {
      method: 'POST',
      headers: {
        'x-api-key':    apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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

/** OCR fallback path — unchanged behaviour. */
export async function createDiditSession(
  input: CreateDiditSessionInput,
): Promise<DiditCreateSessionResponse> {
  const workflowId = input.workflowId ?? requireEnv('DIDIT_WORKFLOW_ID');
  return postSession({
    workflow_id:    workflowId,
    vendor_data:    input.vendorData,
    callback:       input.callback,
    ...(input.portraitImage ? { portrait_image: input.portraitImage } : {}),
  });
}

export type CreateDhaFaceMatchSessionInput = {
  vendorData:          string;
  callback:             string;
  /**
   * REQUIRED — not optional, at both the type level and at runtime below.
   *
   * Didit resolves a stored reference face for `vendor_data` when
   * `portrait_image` is omitted (an approved liveness capture, an
   * ePassport photo, or — critically — a portrait CROPPED FROM THE ID
   * DOCUMENT of a prior approved OCR-path session). A patient who was
   * ever approved via the OCR fallback already has such a stored face.
   * On a LATER DHA-path session, an omitted portrait_image would then
   * silently face-match the live selfie against that stored DOCUMENT
   * portrait and return Approved — meaning we'd believe we matched
   * against the Home Affairs register when we never sent it one. That
   * failure is invisible: no error, no distinguishable webhook shape,
   * just a false Approved.
   *
   * So this is asserted here, before any network call, rather than left
   * to fail (or silently succeed) server-side. Never relax this to
   * optional — see the two dedicated tests in client.test.ts.
   */
  portraitImageBase64: string;
  workflowId?:         string;
};

export async function createDhaFaceMatchSession(
  input: CreateDhaFaceMatchSessionInput,
): Promise<DiditCreateSessionResponse> {
  if (!input.portraitImageBase64) {
    throw new Error(
      'createDhaFaceMatchSession: portraitImageBase64 is required — refusing to create a ' +
      'DHA-path session without it (Didit would silently fall back to any stored face).',
    );
  }

  // Rough size guard on the base64 payload (~4/3 inflation over raw bytes).
  // The 1MB default is an engineering choice, not a confirmed Didit limit
  // — see the final report's unverified-assumptions list. Read per-call
  // (not module-level) so it stays overridable/testable.
  const maxBytes = Number(process.env.DHA_PORTRAIT_MAX_BYTES ?? 1_000_000);
  const approxBytes = Math.floor(input.portraitImageBase64.length * 0.75);
  if (approxBytes > maxBytes) {
    throw new Error(
      `createDhaFaceMatchSession: portrait image (~${approxBytes} bytes) exceeds ` +
      `DHA_PORTRAIT_MAX_BYTES (${maxBytes}).`,
    );
  }

  const workflowId = input.workflowId ?? requireEnv('DIDIT_DHA_WORKFLOW_ID');
  return postSession({
    workflow_id:    workflowId,
    vendor_data:    input.vendorData,
    callback:       input.callback,
    portrait_image: input.portraitImageBase64,
  });
}

/** Absolute base URL for this app, used to build the Didit `callback`. */
export function diditAppBaseUrl(): string {
  return requireEnv('DIDIT_APP_BASE_URL').replace(/\/$/, '');
}
