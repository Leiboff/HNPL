-- ─── Peach Checkout V2 — additive schema ───────────────────────────
--
-- 0076 swapped Paystack → Peach on the legacy OPPWA / COPYandPAY stack.
-- 0077 moves to the recommended product family:
--   • First instalment (CIT) — Checkout V2 embedded.
--   • Instalments 2+ (MIT) — recurring card-on-file API.
--
-- Peach's recurring API (POST /v1/registrations/{id}/payments) requires
-- an `initialTransactionId` reference on every MIT charge — the id of
-- the initial CIT transaction that established the stored credential.
-- The current schema stores the registration id on plans but not the
-- initial transaction id; this migration adds the missing column.
--
-- Columns added by this migration:
--   plans.peach_initial_transaction_id  TEXT NULLABLE
--                                       — The Peach payment id of the
--                                         first CIT transaction on
--                                         this plan (Flow A widget) OR
--                                         the first successful MIT
--                                         charge on the plan when the
--                                         card was pre-tokenised via
--                                         Flow 3 (add-card / registration
--                                         only, no debit). Populated by
--                                         the V2 return route + webhook +
--                                         payWithSavedCard. Once set,
--                                         every subsequent MIT charge
--                                         on this plan passes it in the
--                                         `standingInstruction.initialTransactionId`
--                                         field.
--
--   payments.peach_checkout_id          TEXT NULLABLE
--                                       — Optional convenience column
--                                         for reconciliation. The V2
--                                         checkout `id` returned from
--                                         POST /v2/checkout. Populated
--                                         on the instalment-1 payment
--                                         row so admins can look up a
--                                         payment by the checkout id
--                                         the widget was mounted with,
--                                         without cross-referencing
--                                         merchantTransactionId.
--
-- Not in scope for this migration (kept from 0076):
--   plans.peach_registration_id           — still the reusable token.
--   plans.payment_provider                — still the discriminator.
--   payments.payment_provider             — same.
--   refunds.peach_refund_id               — same.
--   payments.peach_payment_id             — still holds
--                                            merchantTransactionId.
--   plans.paystack_authorization_code     — historic-row column, kept.
--   payment_methods.token / signature     — reusable across providers.
--
-- Additive and backward-compatible. No column drops. No RLS changes.

-- ── 1. plans.peach_initial_transaction_id ────────────────────────────

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS peach_initial_transaction_id TEXT;

CREATE INDEX IF NOT EXISTS plans_peach_initial_transaction_id_idx
  ON plans (peach_initial_transaction_id)
  WHERE peach_initial_transaction_id IS NOT NULL;

COMMENT ON COLUMN plans.peach_initial_transaction_id IS
  'Peach payment id of the initial CIT (Checkout V2) or first '
  'successful MIT (payWithSavedCard) transaction on this plan. '
  'Passed as standingInstruction.initialTransactionId on every '
  'subsequent MIT charge against the recurring endpoint.';

-- ── 2. payments.peach_checkout_id ────────────────────────────────────

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS peach_checkout_id TEXT;

CREATE INDEX IF NOT EXISTS payments_peach_checkout_id_idx
  ON payments (peach_checkout_id)
  WHERE peach_checkout_id IS NOT NULL;

COMMENT ON COLUMN payments.peach_checkout_id IS
  'Optional: the Checkout V2 `id` (returned from POST /v2/checkout) '
  'that produced this payment. Populated on the instalment-1 payment '
  'row for reconciliation. NULL on MIT rows.';

-- ── 3. RLS ───────────────────────────────────────────────────────────
--
-- No changes. New columns inherit the existing row-level policies on
-- plans + payments.
