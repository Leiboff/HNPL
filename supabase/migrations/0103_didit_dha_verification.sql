-- ─── DHA-photo-first identity verification, OCR fallback ────────────────
--
-- Adds the DHA (Department of Home Affairs) registry-photo verification
-- path alongside the existing Didit OCR path (0102). The patient types
-- their SA ID; we look it up against the DHA registry via Didit's
-- standalone database-validation API BEFORE creating any session, then
-- route to one of two Didit workflows depending on the result — see
-- lib/onboarding/dhaVerification.ts (routing) and
-- lib/onboarding/actions.ts::submitIdentityForVerification (orchestration).
--
--   • identity_verification_path         — 'dha' | 'ocr'. Which Didit
--                                           workflow this verification
--                                           attempt used. THE AUTHORITY
--                                           the webhook branches on —
--                                           never the envelope's
--                                           workflow_id (see route.ts).
--   • identity_verification_workflow_id/
--     _version/_environment              — persisted verbatim from the
--                                           webhook envelope on every
--                                           update, for audit ("how was
--                                           this patient verified") and
--                                           so sandbox-environment
--                                           sessions hitting production
--                                           during rollout stay
--                                           identifiable for later purge.
--   • dha_lookup_request_id              — the DHA response's request_id.
--   • dha_lookup_outcome_code            — the resolved zaf_dha_photo
--                                           outcome_code (MATCH/NO_MATCH/
--                                           DOCUMENT_NOT_FOUND/
--                                           BIOMETRIC_IMAGE_UNUSABLE/
--                                           REGISTRY_UNAVAILABLE/other).
--                                           NULL when DHA was never
--                                           called (OCR-only accounts,
--                                           including everyone verified
--                                           before this migration).
--   • dha_consent_at / _consent_version  — explicit consent capture,
--                                           timestamped, BEFORE the DHA
--                                           call is made. Biometric
--                                           special personal information
--                                           under POPIA — consent_version
--                                           lets us know which copy the
--                                           patient actually saw (the
--                                           copy itself is still
--                                           TODO: legal review).
--   • dha_first_name / dha_last_name     — registry-sourced name, used
--                                           as AML input on the DHA path.
--                                           Deliberately NEVER written
--                                           into profiles.first_name/
--                                           last_name — the patient's
--                                           claimed name is theirs to
--                                           own; the registry name is a
--                                           signal, not a correction.
--   • dha_name_mismatch                  — TRUE when dha_first_name/
--                                           dha_last_name differ
--                                           materially from the
--                                           patient's claimed name.
--                                           Captured for review, never
--                                           acted on automatically.
--   • pending_sa_id_number /
--     pending_sa_id_lookup_hash          — holds the DHA-matched,
--                                           consent-gated ID between
--                                           session creation and webhook
--                                           approval, so the CANONICAL
--                                           sa_id_number is only ever
--                                           written atomically alongside
--                                           a confirmed liveness/face-
--                                           match — same invariant the
--                                           OCR path already has (0102).
--                                           Promoted to sa_id_number/
--                                           sa_id_lookup_hash on DHA-path
--                                           Approved; cleared on decline/
--                                           expiry. Deliberately NO
--                                           unique constraint on the
--                                           lookup hash — an abandoned
--                                           session must never lock the
--                                           real owner out of their own
--                                           ID. The 0097 unique index on
--                                           sa_id_lookup_hash remains the
--                                           sole uniqueness authority.
--                                           TTL: cleaned up lazily by
--                                           submitIdentityForVerification
--                                           itself (a fresh submission
--                                           always overwrites its own
--                                           prior pending value before
--                                           creating a new session, and
--                                           the webhook clears these two
--                                           columns on every non-Approved
--                                           terminal status on the DHA
--                                           path). No cron sweep exists
--                                           yet for a session that is
--                                           simply abandoned without ever
--                                           reaching a terminal webhook
--                                           status — flagged as an open
--                                           item in the final report
--                                           rather than built here.
--
-- No photo_base64 / DHA-photo storage column — retention undecided, see
-- final report. Do not persist it until that decision is made.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS identity_verification_path          TEXT,
  ADD COLUMN IF NOT EXISTS identity_verification_workflow_id      TEXT,
  ADD COLUMN IF NOT EXISTS identity_verification_workflow_version INTEGER,
  ADD COLUMN IF NOT EXISTS identity_verification_environment      TEXT,
  ADD COLUMN IF NOT EXISTS dha_lookup_request_id                  TEXT,
  ADD COLUMN IF NOT EXISTS dha_lookup_outcome_code                TEXT,
  ADD COLUMN IF NOT EXISTS dha_face_match_score                   NUMERIC,
  ADD COLUMN IF NOT EXISTS dha_consent_at                         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dha_consent_version                    TEXT,
  ADD COLUMN IF NOT EXISTS dha_first_name                         TEXT,
  ADD COLUMN IF NOT EXISTS dha_last_name                          TEXT,
  ADD COLUMN IF NOT EXISTS dha_name_mismatch                      BOOLEAN,
  ADD COLUMN IF NOT EXISTS pending_sa_id_number                   TEXT,
  ADD COLUMN IF NOT EXISTS pending_sa_id_lookup_hash              TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_identity_verification_path_chk'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_identity_verification_path_chk
      CHECK (identity_verification_path IS NULL OR identity_verification_path IN ('dha', 'ocr'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_identity_verification_environment_chk'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_identity_verification_environment_chk
      CHECK (identity_verification_environment IS NULL OR identity_verification_environment IN ('live', 'sandbox'));
  END IF;
END $$;

-- Widen the 0102 reason CHECK with the DHA-path decline/review reasons.
-- Constraints can't be ALTERed in place — drop and recreate.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_identity_verification_reason_chk'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_identity_verification_reason_chk;
  END IF;

  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_identity_verification_reason_chk
    CHECK (
      identity_verification_reason IS NULL
      OR identity_verification_reason IN (
        -- OCR path (0102)
        'no_id_extracted', 'invalid_id', 'underage', 'id_already_registered',
        -- DHA path
        'dha_no_match', 'dha_document_not_found', 'dha_deceased', 'dha_id_blocked',
        'dha_id_mismatch', 'dha_unrecognised_outcome', 'dha_not_on_register',
        'face_match_below_threshold',
        -- Webhook-level integrity checks (either path)
        'workflow_path_mismatch', 'aml_hit_or_unavailable'
      )
    );
END $$;

COMMENT ON COLUMN public.profiles.identity_verification_path IS
  'dha or ocr — which verification path this attempt used. The webhook branches on THIS column, never on the envelope workflow_id (which is only a cross-check, logged loudly on mismatch, never used to select branch logic).';
COMMENT ON COLUMN public.profiles.identity_verification_workflow_id IS
  'Didit workflow_id from the webhook envelope. Audit trail: which workflow verified this patient.';
COMMENT ON COLUMN public.profiles.identity_verification_workflow_version IS
  'Didit workflow_version from the webhook envelope.';
COMMENT ON COLUMN public.profiles.identity_verification_environment IS
  'live or sandbox, from the webhook envelope. Sandbox sessions hitting the production webhook during rollout must stay identifiable for later purge.';
COMMENT ON COLUMN public.profiles.dha_lookup_outcome_code IS
  'The zaf_dha_photo outcome_code resolved from the DHA database-validation response (validations[].service_id===''zaf_dha_photo''). NULL when DHA was never called.';
COMMENT ON COLUMN public.profiles.dha_face_match_score IS
  'decision.face_matches[0].score from the DHA-path webhook, persisted on EVERY outcome (approve/review/decline) so the approve/review/decline thresholds (DHA_FACE_MATCH_APPROVE_MIN / DHA_FACE_MATCH_REVIEW_MIN) can be tuned retrospectively against the real score distribution.';
COMMENT ON COLUMN public.profiles.dha_consent_at IS
  'Timestamp of explicit consent to the DHA registry lookup, captured BEFORE the lookup is made. Biometric special personal information under POPIA.';
COMMENT ON COLUMN public.profiles.dha_first_name IS
  'Registry-sourced first name from the DHA lookup. Used as AML screening input on the DHA path. Never written into profiles.first_name.';
COMMENT ON COLUMN public.profiles.dha_name_mismatch IS
  'TRUE when dha_first_name/dha_last_name differ materially from the patient''s claimed name. Captured for review; never acted on automatically.';
COMMENT ON COLUMN public.profiles.pending_sa_id_number IS
  'DHA-matched, consent-gated SA ID, held here between session creation and webhook approval. Promoted to sa_id_number atomically on DHA-path Approved (same invariant the OCR path already has). No uniqueness enforced here — see pending_sa_id_lookup_hash.';
COMMENT ON COLUMN public.profiles.pending_sa_id_lookup_hash IS
  'Blind-index counterpart to pending_sa_id_number. Deliberately carries NO unique constraint — an abandoned/expired session must never lock the real ID owner out of their own account. The 0097 unique index on sa_id_lookup_hash (the CANONICAL column) remains the sole uniqueness authority.';
