-- ─── Terms acceptance — persist which T&Cs each customer agreed to ──────
--
-- Compliance: the signup "I agree" tick and the payment-plan "I agree"
-- tick were captured CLIENT-SIDE ONLY — nothing about the acceptance
-- reached the DB (see app/checkout/[token]/anon-routing-rule.test.ts,
-- which pinned "captured client-side but NOT sent to the DB"). This
-- closes that gap: acceptance is now recorded server-side, at the moment
-- of the action, on the record it pertains to.
--
--   • profiles.terms_accepted_at / terms_version — stamped by
--     signUpPatient right after auth.signUp (the account-level accept).
--   • plans.terms_accepted_at / terms_version — stamped on the plan
--     activation UPDATE (acceptPlan / payWithSavedCard / initiateCheckout),
--     the per-plan accept of the payment-plan terms + debit mandate.
--
-- terms_version is the version string from lib/legal/terms.ts
-- (TERMS_VERSION, '1.0' at time of writing). Storing it per-row is a
-- durable audit trail of exactly which version each customer agreed to,
-- so a later revision never rewrites history.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, no backfill, no
-- constraint / RLS / default changes. Existing rows keep NULL (they
-- pre-date acceptance capture) — the app treats NULL as "not recorded".

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS terms_version     TEXT;

ALTER TABLE plans    ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE plans    ADD COLUMN IF NOT EXISTS terms_version     TEXT;

COMMENT ON COLUMN profiles.terms_accepted_at IS
  'When the customer accepted the betternow customer T&Cs at signup. NULL for accounts predating acceptance capture (migration 0081).';
COMMENT ON COLUMN profiles.terms_version IS
  'Version of the T&Cs accepted at signup (lib/legal/terms.ts TERMS_VERSION, e.g. ''1.0''). Per-row audit of what was agreed to.';
COMMENT ON COLUMN plans.terms_accepted_at IS
  'When the customer accepted the payment-plan terms + debit mandate at plan activation. NULL for plans predating acceptance capture (migration 0081).';
COMMENT ON COLUMN plans.terms_version IS
  'Version of the T&Cs accepted at plan activation (lib/legal/terms.ts TERMS_VERSION). Per-plan audit of what was agreed to.';
