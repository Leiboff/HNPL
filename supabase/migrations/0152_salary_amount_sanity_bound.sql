-- Keep the public database boundary aligned with lib/salaryAmount.ts.
-- salary_amount is patient-declared income, not verified income, and must
-- never be treated as sufficient evidence for an affordability decision.
--
-- NUMERIC(12,2) rounded input before a CHECK could inspect it. Use unconstrained
-- NUMERIC and enforce scale explicitly so PostgREST cannot silently turn an
-- excessive-precision declaration into a different value.

ALTER TABLE profiles
  ALTER COLUMN salary_amount TYPE NUMERIC
  USING salary_amount::NUMERIC;

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_salary_amount_check;

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_salary_amount_ceiling;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_salary_amount_sanity_bound
  CHECK (
    salary_amount IS NULL
    OR (
      salary_amount > 0
      AND salary_amount <= 100000
      AND salary_amount = round(salary_amount, 2)
    )
  ) NOT VALID;

COMMENT ON COLUMN profiles.salary_amount IS
  'Patient-declared monthly income in rand. Unverified: underwriting must use independently verified affordability evidence.';
