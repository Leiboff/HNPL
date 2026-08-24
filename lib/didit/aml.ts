// SERVER-ONLY. Never import in a client component.
//
// Standalone AML screening — POST /v3/aml/.
//
// Moved out of the Didit workflow graph entirely (AML requires OCR or
// KYB_REGISTRY to be present in a workflow, and the DHA path's workflow
// has neither) and called standalone from our server on BOTH paths, so
// there is exactly one AML code path instead of two divergent ones. See
// app/api/verification/didit/webhook/route.ts, which calls this after
// the identity/liveness/face-match decision is otherwise favourable, on
// whichever name/DOB is best available for that path (registry-sourced
// on the DHA path, OCR-extracted on the OCR fallback path).
//
// ── UNVERIFIED ──────────────────────────────────────────────────────
// The endpoint path is taken from the module catalogue description, not
// independently confirmed (docs.didit.me is network-blocked here). Kept
// behind this one function so the path/payload shape can change without
// touching either call site. See the integration's final report.

const DIDIT_API_BASE = 'https://verification.didit.me';
const DEFAULT_TIMEOUT_MS = 8_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in environment variables.`);
  return v;
}

export type ScreenAmlInput = {
  vendorData:    string;
  firstName?:    string;
  lastName?:     string;
  dateOfBirth?:  string; // YYYY-MM-DD
};

export type ScreenAmlOutcome =
  | { kind: 'success'; data: import('./types').AmlScreeningResult }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'request_error'; status: number; detail: string };

export async function screenAml(input: ScreenAmlInput): Promise<ScreenAmlOutcome> {
  let apiKey: string;
  try {
    apiKey = requireEnv('DIDIT_API_KEY');
  } catch (err) {
    // A missing key is a configuration problem, not a decision about
    // the applicant — callers treat 'unavailable' the same way they'd
    // treat AML being unreachable (route to review, never auto-approve).
    return { kind: 'unavailable', detail: err instanceof Error ? err.message : String(err) };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${DIDIT_API_BASE}/v3/aml/`, {
        method:  'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendor_data:   input.vendorData,
          first_name:    input.firstName,
          last_name:     input.lastName,
          date_of_birth: input.dateOfBirth,
        }),
        signal: controller.signal,
      });
    } catch (err) {
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

    const data = (await res.json()) as import('./types').AmlScreeningResult;
    return { kind: 'success', data };
  } finally {
    clearTimeout(timeout);
  }
}
