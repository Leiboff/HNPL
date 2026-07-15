-- ─── Peach Payments swap — additive schema ─────────────────────────
--
-- Paystack has been fully replaced by Peach Payments (OPPWA COPYandPAY
-- + server-to-server registration tokens). The switch is a hard cut —
-- no real patients have transacted — but historic test rows may still
-- reference Paystack columns, so those columns STAY. We add Peach
-- equivalents alongside and gate the code path with a `payment_provider`
-- discriminator that defaults to 'peach' for every new row.
--
-- Columns kept for backward compatibility (never dropped):
--   plans.paystack_authorization_code
--   refunds.paystack_refund_id
--   payment_methods.signature   (Paystack card fingerprint)
--   payment_methods.token       (generic — reused for Peach registrationId)
--   payments.peach_payment_id   (already-generic name; keeps holding the
--                               transaction reference — the merchantTransactionId
--                               we send Peach and match on incoming webhooks)
--
-- Columns added by this migration:
--   plans.peach_registration_id           TEXT NULLABLE — the reusable
--                                         registration id returned by
--                                         COPYandPAY when a CIT charge
--                                         also stores the card. Used by
--                                         collections cron via
--                                         POST /v1/registrations/{id}/payments.
--
--   plans.payment_provider                TEXT NOT NULL DEFAULT 'peach'
--                                         CHECK IN ('paystack','peach').
--                                         Historic rows get 'paystack';
--                                         everything new is 'peach'.
--
--   payments.payment_provider             TEXT NOT NULL DEFAULT 'peach'
--                                         CHECK IN ('paystack','peach').
--                                         Same discriminator; scoped to
--                                         the payment row so a mid-flip
--                                         plan can be reasoned about.
--
--   refunds.peach_refund_id               TEXT NULLABLE — parallel to
--                                         paystack_refund_id. Holds the
--                                         payment id of the RF-type
--                                         transaction Peach returns on
--                                         a POST /v1/payments/{id} refund.
--
-- Backfill: every existing plan / payment / refund is authored under
-- the Paystack rail and gets its provider stamped 'paystack'.

-- ── 1. plans ─────────────────────────────────────────────────────────

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS peach_registration_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_provider      TEXT;

-- Backfill first, THEN NOT NULL — the schema is small so the
-- backfill is instant, but the pattern generalises.
UPDATE plans
   SET payment_provider = 'paystack'
 WHERE payment_provider IS NULL
   AND paystack_authorization_code IS NOT NULL;

UPDATE plans
   SET payment_provider = 'peach'
 WHERE payment_provider IS NULL;

ALTER TABLE plans
  ALTER COLUMN payment_provider SET NOT NULL,
  ALTER COLUMN payment_provider SET DEFAULT 'peach';

ALTER TABLE plans
  DROP CONSTRAINT IF EXISTS plans_payment_provider_check;
ALTER TABLE plans
  ADD CONSTRAINT plans_payment_provider_check
  CHECK (payment_provider IN ('paystack', 'peach'));

CREATE INDEX IF NOT EXISTS plans_peach_registration_id_idx
  ON plans (peach_registration_id)
  WHERE peach_registration_id IS NOT NULL;

-- ── 2. payments ──────────────────────────────────────────────────────
--
-- The `peach_payment_id` column is already generic-named (initial
-- schema). It continues to hold the merchantTransactionId we mint
-- per attempt — the string the Peach webhook echoes back and the
-- string we search on to reconcile. No rename; only add the
-- provider discriminator.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_provider TEXT;

UPDATE payments SET payment_provider = 'paystack' WHERE payment_provider IS NULL;

ALTER TABLE payments
  ALTER COLUMN payment_provider SET NOT NULL,
  ALTER COLUMN payment_provider SET DEFAULT 'peach';

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_payment_provider_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_payment_provider_check
  CHECK (payment_provider IN ('paystack', 'peach'));

-- ── 3. refunds ───────────────────────────────────────────────────────

ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS peach_refund_id TEXT;

-- No NOT NULL / discriminator on refunds — the existing
-- paystack_refund_id column stays nullable too, and we can tell which
-- rail a refund came from by looking at which id column is populated.

CREATE INDEX IF NOT EXISTS refunds_peach_refund_id_idx
  ON refunds (peach_refund_id)
  WHERE peach_refund_id IS NOT NULL;

-- ── 4. RLS / policies ────────────────────────────────────────────────
--
-- No changes. The existing RLS on plans, payments, refunds continues to
-- apply. New columns inherit the row-level access of the row.

COMMENT ON COLUMN plans.peach_registration_id IS
  'Peach OPPWA registration id — the reusable token returned when a '
  'CIT charge creates a stored credential. Used by the collections '
  'cron via POST /v1/registrations/{id}/payments.';

COMMENT ON COLUMN plans.payment_provider IS
  'Which payment rail this plan was authored under. Historic Paystack '
  'plans keep their auth code in paystack_authorization_code; new '
  'plans populate peach_registration_id.';

COMMENT ON COLUMN payments.payment_provider IS
  'Payment rail for this row. Historic Paystack payments retain the '
  'reference in peach_payment_id (same column, different origin); the '
  'Peach webhook and the Paystack webhook are separate routes.';

COMMENT ON COLUMN refunds.peach_refund_id IS
  'Peach RF-type payment id — parallel to paystack_refund_id.';
