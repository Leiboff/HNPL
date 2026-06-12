-- Stores the Paystack reusable authorization code on the plan so future
-- instalments can be charged without the patient re-entering card details.
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS paystack_authorization_code TEXT;

-- Marks a payment_methods row as having a reusable card authorization.
-- Added separately from the original 0017 migration because it was determined
-- after that migration was applied.
ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS reusable BOOLEAN NOT NULL DEFAULT false;
