-- HNPL Nullable Plan Type
-- The patient now chooses 2 or 3 instalments when accepting a bill,
-- so these fields are unknown at bill-creation time.

ALTER TABLE applications ALTER COLUMN plan_type DROP NOT NULL;

ALTER TABLE plans ALTER COLUMN plan_type DROP NOT NULL;
ALTER TABLE plans ALTER COLUMN instalment_amount DROP NOT NULL;
