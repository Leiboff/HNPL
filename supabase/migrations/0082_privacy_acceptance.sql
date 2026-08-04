-- ─── Privacy Policy acceptance — record which policy version applied ────
--
-- Sibling of 0081 (terms acceptance). The signup + plan-activation "I
-- agree" ticks are a SINGLE combined acceptance of both the Customer
-- T&Cs and the Privacy Policy, at one moment. 0081 already records that
-- moment (terms_accepted_at) and the T&Cs version (terms_version). This
-- adds the Privacy Policy version marker alongside it, so a row is a
-- durable audit of BOTH documents the customer agreed to.
--
--   • profiles.privacy_version — stamped by signUpPatient next to
--     terms_version (and by the checkout profile upsert for
--     checkout-origin patients).
--   • plans.privacy_version — stamped on the plan activation UPDATE
--     (acceptPlan / payWithSavedCard / initiateCheckout) next to
--     terms_version.
--
-- privacy_version is PRIVACY_VERSION from lib/legal/privacy.ts ('1.0').
-- There is NO separate privacy timestamp — terms_accepted_at (0081)
-- covers the combined acceptance instant.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, no backfill, no
-- constraint / RLS / default changes. Existing rows keep NULL — they
-- pre-date privacy-version capture.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS privacy_version TEXT;
ALTER TABLE plans    ADD COLUMN IF NOT EXISTS privacy_version TEXT;

COMMENT ON COLUMN profiles.privacy_version IS
  'Version of the Privacy Policy accepted at signup (lib/legal/privacy.ts PRIVACY_VERSION, e.g. ''1.0''). Combined with terms_version/terms_accepted_at (0081). NULL for rows predating capture (migration 0082).';
COMMENT ON COLUMN plans.privacy_version IS
  'Version of the Privacy Policy accepted at plan activation (lib/legal/privacy.ts PRIVACY_VERSION). Combined with terms_version/terms_accepted_at (0081). NULL for rows predating capture (migration 0082).';
