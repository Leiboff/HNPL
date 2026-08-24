// SERVER-ONLY. Never import in a client component.
//
// Standalone DHA (Department of Home Affairs) registry-photo lookup —
// POST /v3/database-validation/. Called BEFORE any Didit session is
// created; see lib/onboarding/dhaVerification.ts for how the response
// is turned into a routing decision, and lib/onboarding/actions.ts's
// submitIdentityForVerification for the caller.
//
// ── UNVERIFIED ──────────────────────────────────────────────────────
// docs.didit.me is network-blocked from this environment. Request field
// names (`national_id`, `consent`) and the multipart/form-data encoding
// are taken from a source outside this environment that could not be
// independently confirmed here — see the integration's final report.
// The design is deliberately fail-safe against this being wrong: a
// malformed request produces an HTTP 4xx, which callDhaPhotoLookup
// surfaces as `request_error` (a hard error our own code raised,
// investigated by a human) — NEVER as `unavailable` (which routes to
// the OCR fallback). Conflating "we sent a bad request" with "the
// registry is down" would let a fabricated ID silently reach the
// weaker document-scan path, which is exactly the failure mode this
// integration exists to prevent. If these field names turn out to be
// wrong, the DHA path simply stops working (loudly) until fixed — it
// does not fail open.

const DIDIT_API_BASE = 'https://verification.didit.me';
const DEFAULT_TIMEOUT_MS = 8_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in environment variables.`);
  return v;
}

export type DhaPhotoLookupInput = {
  /** Cleaned, already-validated 13-digit SA ID. */
  nationalId: string;
  /** Our internal user id. */
  vendorData: string;
};

export type DhaLookupOutcome =
  // 2xx — a real DHA response, however inconclusive. Routing logic
  // (lib/onboarding/dhaVerification.ts) decides what to do with it.
  | { kind: 'success'; data: import('./types').DhaLookupResponse }
  // Timeout, connection failure, or 5xx — the registry (or the path to
  // it) is unavailable. The ONLY outcome that may route to OCR fallback.
  | { kind: 'unavailable'; detail: string }
  // Any other non-2xx (4xx). Our own request was rejected — almost
  // certainly an integration bug (wrong field name, bad auth), not a
  // registry-availability signal. Must NEVER be treated as `unavailable`.
  | { kind: 'request_error'; status: number; detail: string };

export async function callDhaPhotoLookup(input: DhaPhotoLookupInput): Promise<DhaLookupOutcome> {
  let apiKey: string;
  try {
    apiKey = requireEnv('DIDIT_API_KEY');
  } catch (err) {
    // A missing key is a configuration problem, not the registry being
    // down — but it has the exact same operational answer (fall back to
    // OCR rather than block the patient), so it's classified the same.
    return { kind: 'unavailable', detail: err instanceof Error ? err.message : String(err) };
  }

  const form = new FormData();
  form.set('issuing_state', 'ZAF');
  form.set('services', 'zaf_dha_photo');
  form.set('national_id', input.nationalId);
  form.set('consent', 'true');
  form.set('vendor_data', input.vendorData);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${DIDIT_API_BASE}/v3/database-validation/`, {
        method:  'POST',
        headers: { 'x-api-key': apiKey },
        body:    form,
        signal:  controller.signal,
      });
    } catch (err) {
      // fetch() throwing means we never got an HTTP response at all —
      // timeout (AbortError) or a connection-level failure. Both are
      // "the registry is unavailable to us right now", never a request
      // shape problem.
      const detail = err instanceof Error ? err.message : String(err);
      return { kind: 'unavailable', detail };
    }

    if (res.status >= 500) {
      const detail = await res.text().catch(() => '');
      return { kind: 'unavailable', detail: `HTTP ${res.status}: ${detail.slice(0, 500)}` };
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { kind: 'request_error', status: res.status, detail: detail.slice(0, 500) };
    }

    const data = (await res.json()) as import('./types').DhaLookupResponse;
    return { kind: 'success', data };
  } finally {
    clearTimeout(timeout);
  }
}
