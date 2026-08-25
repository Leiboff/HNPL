-- Remove the OCR document-scan fallback; its cases become review reasons.
--
-- Previously, a registry that failed to ANSWER (timeout, 5xx, no usable
-- portrait) routed the applicant to an OCR fallback: photograph your ID
-- card, and we match your selfie against the picture on the card.
--
-- That was strictly weaker evidence than the path it substituted for — a
-- photo of a plastic card is forgeable; a portrait fetched from the
-- population register by ID number is not — and it was substituted
-- SILENTLY, on a vendor timeout, with no signal that it had happened.
-- For a credit provider, quietly downgrading identity assurance is the
-- wrong default.
--
-- It also actively hid bugs. Any failure inside the fallback surfaced
-- INSTEAD of whatever caused the fallback, which is how a missing
-- DIDIT_WORKFLOW_ID came to mask a portrait-resize failure in
-- production: the logs showed only the second error.
--
-- These two reasons therefore move from "silently take a weaker path" to
-- "a human looks at it". Both describe a legitimate applicant we could
-- not biometrically verify right now — the registry did not refuse them,
-- it failed to answer. Declining them would punish someone for a vendor
-- outage.
--
-- OPERATIONAL CONSEQUENCE, stated plainly: a registry outage now sends
-- every affected applicant to the review queue rather than completing
-- them via OCR. That queue must be staffed for this trade to be
-- acceptable, and a rise in either reason is an outage signal.

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
            -- Datanamix bureau path (0104)
            'dnx_no_match',
            'dnx_not_found',
            'dnx_deceased',
            'dnx_id_blocked',
            'dnx_id_mismatch',
            'dnx_unrecognised_outcome',
            'dnx_hanis_not_matched',
            -- Formerly OCR-fallback, now review (this migration)
            'registry_unavailable',
            'biometric_image_unusable'
        ]::text[])
    );

-- NOTE: 'no_id_extracted' is retained above deliberately. It can only be
-- produced by the OCR path, which no longer runs, but historical rows may
-- still carry it and a CHECK constraint applies to existing data. Dropping
-- the value would make this migration fail on any table that has one.
