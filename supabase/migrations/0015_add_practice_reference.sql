-- Adds the optional doctor's-own-reference column to plans.
-- Kept as a separate migration because 0014 (invoice_number) was already applied
-- before this column was decided on.

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS practice_reference TEXT;
