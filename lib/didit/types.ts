// ─── Didit API types (v3) ───────────────────────────────────────────────
//
// Trimmed to the fields this integration actually reads. See
// https://docs.didit.me/reference/data-models for the full schema.

export type DiditSessionStatus =
  | 'Not Started'
  | 'In Progress'
  | 'Awaiting User'
  | 'In Review'
  | 'Approved'
  | 'Declined'
  | 'Resubmitted'
  | 'Abandoned'
  | 'Expired'
  | 'Kyc Expired';

export type DiditCreateSessionResponse = {
  session_id:       string;
  session_number:   number;
  session_token:    string;
  url:              string;
  vendor_data:      string | null;
  metadata:         Record<string, unknown> | null;
  status:           DiditSessionStatus;
  workflow_id:      string;
  workflow_version: number;
  callback:         string | null;
};

export type DiditIdVerification = {
  node_id?:         string;
  status?:          string;
  first_name?:      string | null;
  last_name?:       string | null;
  document_number?: string | null;
  /** For a South African ID document this IS the 13-digit SA ID number. */
  personal_number?: string | null;
  date_of_birth?:   string | null;
  nationality?:     string | null;
  warnings?:        unknown[];
};

export type DiditLivenessCheck = { node_id?: string; status?: string; score?: number };
export type DiditFaceMatch     = { node_id?: string; status?: string; score?: number };
export type DiditAmlScreening  = { node_id?: string; status?: string; score?: number; total_hits?: number };

// ─── Standalone Database Validation API (DHA registry lookup) ──────────
//
// POST /v3/database-validation/ — request field names and encoding
// (multipart/form-data, `national_id`) are UNVERIFIED against Didit's own
// docs (network-blocked from this environment); see lib/didit/dha.ts and
// the integration's final report for the full caveat. Every field below
// is optional on purpose — the response shape is trusted only as far as
// what's actually present (see lib/onboarding/dhaVerification.ts).

/** One row of `validations[]` — locate by `service_id`, never by index. */
export type DhaValidationRow = {
  service_id?:     string;
  service_name?:   string;
  outcome_code?:   string;
  outcome_detail?: string;
  validation?:     unknown;
  source_data?: {
    photo_base64?:                    string;
    deceased?:                        unknown;
    id_blocked?:                      unknown;
    on_national_population_register?: unknown;
    on_hanis_biometric_register?:     unknown;
    smart_card_issued?:               unknown;
    first_name?:                      string;
    last_name?:                       string;
    identification_number?:           string;
  };
};

export type DhaLookupResponse = {
  request_id?:     string;
  status?:         string;
  issuing_state?:  string;
  match_type?:     string;
  validations?:    DhaValidationRow[];
};

// ─── Standalone AML screening API ───────────────────────────────────────
//
// POST /v3/aml/ — endpoint path is UNVERIFIED (taken from the module
// catalogue description, not independently confirmed). Kept behind
// lib/didit/aml.ts's screenAml() boundary so the shape can change
// without touching call sites.

export type AmlScreeningResult = {
  status?:      string;
  score?:       number;
  total_hits?:  number;
  hits?:        unknown[];
};

export type DiditDecision = {
  id_verifications?: DiditIdVerification[] | null;
  liveness_checks?:  DiditLivenessCheck[]  | null;
  face_matches?:     DiditFaceMatch[]      | null;
  aml_screenings?:   DiditAmlScreening[]   | null;
};

// The "session webhook envelope (V3)" — status.updated / data.updated for
// a KYC session. Business (KYB) sessions carry extra fields we don't use.
export type DiditWebhookEvent = {
  event_id:         string;
  webhook_type:     string;
  timestamp:        number;
  created_at:       number;
  application_id:   string;
  environment:      'live' | 'sandbox';
  session_id:       string;
  status:           DiditSessionStatus;
  workflow_id:      string;
  workflow_version: number;
  /** Our internal user id — set to profiles.id at session creation. */
  vendor_data:      string | null;
  metadata:         Record<string, unknown> | null;
  decision?:        DiditDecision | null;
};
