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
// POST /v3/database-validation/ — VERIFIED against the live API on
// 2026-08-24. Request is multipart/form-data with `national_id` (JSON
// also works; `identification_number` is rejected with an explicit
// "Missing required fields: national_id"). Response shape below is
// copied from a real live response.
//
// NOTE: the sandbox environment returns a DIFFERENT, non-representative
// shape — `validations` as an object of field-level match results, with
// no source_data and no photo. Do NOT develop against sandbox responses
// for this endpoint; they will mislead you. Every field is still
// optional on purpose (see lib/onboarding/dhaVerification.ts).

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
    marital_status?:                  string;
    transaction_number?:              string;
    birth_place_country_code?:        string;
    first_name?:                      string;
    last_name?:                       string;
    identification_number?:           string;
  };
};

/**
 * The `database_validation` envelope. Everything except `request_id`,
 * `vendor_data`, `metadata` and `created_at` lives in here — an earlier
 * draft of this type read `validations` from the top level, which meant
 * every lookup found no row and routed to review.
 */
export type DhaDatabaseValidation = {
  status?:          string;
  issuing_state?:   string;
  validation_type?: string;
  match_type?:      string;
  match_score?:     number;
  screened_data?:   Record<string, unknown>;
  warnings?:        unknown[];
  services_used?:   string[];
  validations?:     DhaValidationRow[];
};

export type DhaLookupResponse = {
  request_id?:          string;
  vendor_data?:         string | null;
  metadata?:            Record<string, unknown> | null;
  created_at?:          string;
  database_validation?: DhaDatabaseValidation;
};

// ─── Standalone AML screening API ───────────────────────────────────────
//
// POST /v3/aml/ — endpoint path is UNVERIFIED (taken from the module
// catalogue description, not independently confirmed). Kept behind
// lib/didit/aml.ts's screenAml() boundary so the shape can change
// without touching call sites.

// NOTE: `aml_screenings` is retained on the decision envelope because
// Didit still SENDS it — the field exists in the webhook payload whether
// or not we act on it. We no longer read it: standalone AML screening was
// removed (see the note in app/api/verification/didit/webhook/route.ts).
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
