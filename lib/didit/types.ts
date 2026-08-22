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
