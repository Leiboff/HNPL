// Datanamix "Profile Plus ID and Photo Verification" response types.
//
// POST /v1/id-verification/ProfilePlusIDVerificationAndPhoto
//
// Shape VERIFIED against the live sandbox on 2026-08-25. Note that this
// is a CREDIT BUREAU copy of Home Affairs data, not a live DHA query —
// `OfflineIndicator` and `LastUpdated` quantify the lag (observed:
// "Yes" / "Less than 30 days"). Every disqualifying flag we read here
// may therefore be up to a month behind the real register.
//
// Every field is optional on purpose. See the absent-by-default
// reasoning in lib/onboarding/dhaVerification.ts — a MISSING field must
// never receive the safe/permissive interpretation.

export type DatanamixIdVerificationResults = {
  IDNumber?:             string;
  /** Observed: "Matched". Vocabulary not documented as exhaustive. */
  IDNumberMatchStatus?:  string;
  Names?:                string;
  Surname?:              string;
  Gender?:               string;
  DateOfBirth?:          string;
  BirthPlace?:           string;
  /** Observed: "Alive". NOT a boolean — see mapDeceasedStatus. */
  DeceasedStatus?:       string;
  DeceasedDate?:         string;
  MarriageStatus?:       string;
  MarriageDate?:         string;
  IDBookIssuedDate?:     string;
  IDCardIndicator?:      string;
  IDCardDate?:           string;
  IDSequenceNumber?:     string;
  /** Observed: "NO". Note UPPERCASE — parseFlag lowercases first. */
  IDNumberBlocked?:      string;
  /** Observed: "Yes" — i.e. served from the bureau copy, not live DHA. */
  OfflineIndicator?:     string;
  LastUpdatedIndicator?: string;
  /** Observed: "Less than 30 days". The staleness window, in prose. */
  LastUpdated?:          string;
};

export type DatanamixBiometricResults = {
  /** Observed: "True" (string, not boolean). */
  HasImage?:      string;
  /** Observed: "Matched". Closest analogue to DHA's HANIS register flag. */
  HanisIDMatch?:  string;
  /**
   * Base64 portrait. Observed at ~2.53M chars (~1.9MB) in sandbox —
   * roughly 47x the ~40KB Didit's DHA endpoint returns, and over the
   * default DHA_PORTRAIT_MAX_BYTES. MUST be downscaled before being
   * passed to createDhaFaceMatchSession; see lib/datanamix/portrait.ts.
   */
  ImageBase64?:   string;
};

export type DatanamixProfilePlusResponse = {
  Header?: {
    SearchDate?:       string;
    CreatedUserId?:    number;
    ReportName?:       string;
    ReportReference?:  string;
    ClientReference?:  string;
    ReportType?:       string;
  };
  Result?: {
    IDVerificationResults?:        DatanamixIdVerificationResults;
    BiometricVerificationResults?: DatanamixBiometricResults;
  } | null;
  PDFReport?:    string;
  Success?:      boolean;
  Messages?:     string[];
  /**
   * The ONLY field to branch on. Datanamix's documented HTTP 404 covers
   * two unrelated situations — "this product is not activated on your
   * account" and ResponseCode 4 "no record found" — so HTTP status alone
   * cannot distinguish an account misconfiguration from a non-existent
   * identity. Routing on status would reject every applicant whenever
   * the product was switched off.
   *
   *   0 — successful search
   *   4 — not found
   *   5 — service unavailable (connection timed out)
   *   6 — validation error on the submitted ID
   *   7 — internal system error
   *   8 — ID belongs to a minor
   * 403 — forbidden (bad/expired token)
   */
  ResponseCode?: number;
};
