-- Datanamix (credit-bureau) identity verification — reason codes and
-- provenance columns.
--
-- Context: 0103 added the DHA-photo-first path against Didit's live
-- Home Affairs query. This adds the bureau-sourced alternative
-- (Datanamix Profile Plus ID + Photo), which is materially cheaper
-- (~R4.50 vs ~$1.10) but serves a COPY of Home Affairs data rather
-- than a live query.
--
-- Why separate dnx_* reasons instead of reusing dha_*: the dha_* values
-- assert "the Department of Home Affairs said so". A bureau value means
-- "a credit bureau's copy of Home Affairs data — observed as up to 30
-- days stale — said so". Those are different evidentiary claims, and in
-- a lending dispute over a declined or approved applicant the
-- difference is the whole question. Reusing the dha_* codes would make
-- the audit trail unable to answer "what did we actually know, and how
-- current was it, at the moment we decided?"

ALTER TABLE profiles
    DROP CONSTRAINT IF EXISTS profiles_identity_verification_reason_check;

ALTER TABLE profiles
    ADD CONSTRAINT profiles_identity_verification_reason_check
    CHECK (
        identity_verification_reason IS NULL
        OR identity_verification_reason = ANY (ARRAY[
            -- Pre-DHA (0102)
            'no_id_extracted',
            'invalid_id',
            'underage',
            'id_already_registered',
            -- Didit live DHA path (0103)
            'dha_no_match',
            'dha_document_not_found',
            'dha_deceased',
            'dha_id_blocked',
            'dha_id_mismatch',
            'dha_unrecognised_outcome',
            'dha_not_on_register',
            'face_match_below_threshold',
            'workflow_path_mismatch',
            'aml_hit_or_unavailable',
            -- Datanamix bureau path (this migration)
            'dnx_no_match',
            'dnx_not_found',
            'dnx_deceased',
            'dnx_id_blocked',
            'dnx_id_mismatch',
            'dnx_unrecognised_outcome',
            'dnx_hanis_not_matched'
        ]::text[])
    );

-- Which provider produced the identity decision. Without this, a
-- dnx_*/dha_* reason is the only clue, and rows whose reason is NULL
-- (i.e. approvals) carry no provenance at all — meaning we could not
-- later tell whether an approved patient was verified against a live
-- registry or a month-old bureau copy.
ALTER TABLE profiles
    ADD COLUMN identity_verification_provider TEXT
        CHECK (identity_verification_provider IS NULL
               OR identity_verification_provider IN ('didit_dha', 'datanamix'));

COMMENT ON COLUMN profiles.identity_verification_provider IS
  'Which registry source produced the identity decision: didit_dha (live '
  'Home Affairs query) or datanamix (credit-bureau copy). Set on both '
  'approve and decline paths.';

-- The staleness the bureau itself declared at decision time. Datanamix
-- returns OfflineIndicator ("Yes") and LastUpdated ("Less than 30
-- days") on every call; recording them makes the lag auditable
-- per-decision rather than a general known-unknown. NULL on the
-- didit_dha path, which is a live query and has no lag to declare.
ALTER TABLE profiles
    ADD COLUMN identity_source_offline BOOLEAN,
    ADD COLUMN identity_source_last_updated TEXT;

COMMENT ON COLUMN profiles.identity_source_offline IS
  'Datanamix OfflineIndicator at decision time — true when served from '
  'the bureau copy rather than a live DHA query. NULL for didit_dha.';

COMMENT ON COLUMN profiles.identity_source_last_updated IS
  'Datanamix LastUpdated at decision time, verbatim (e.g. "Less than 30 '
  'days"). Free-text by the vendor''s own design, so stored as TEXT '
  'rather than parsed into an interval. NULL for didit_dha.';
