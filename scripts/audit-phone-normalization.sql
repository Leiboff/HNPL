-- ─── Read-only audit: would migration 0042_normalize_phone_values do? ───────
--
-- Reports, per row in profiles.phone and practices.phone:
--   WILL_NULL    → migration will SET phone = NULL (and RAISE NOTICE the
--                  masked value). Post-migration invariant: every
--                  non-null phone is +27XXXXXXXXX.
--   already_ok   → migration will skip silently (already in +27XXXXXXXXX form)
--   will_update  → migration will rewrite to the +27XXXXXXXXX form
--
-- Runs nothing destructive. Run via the Supabase SQL Editor (or
-- `supabase db query` if you have the CLI's psql wrapper set up).
--
-- The CASE expression here MUST stay in sync with
-- supabase/migrations/0042_normalize_phone_values.sql.
-- Both also mirror lib/validation/phone.ts.

WITH src AS (
  SELECT 'profiles'  AS source, id::text AS id, phone FROM profiles
   WHERE phone IS NOT NULL AND phone <> ''
  UNION ALL
  SELECT 'practices' AS source, id::text AS id, phone FROM practices
   WHERE phone IS NOT NULL AND phone <> ''
),
cleaned AS (
  SELECT
    source, id, phone AS original,
    regexp_replace(phone, '[\s\-()]', '', 'g') AS digits
  FROM src
),
normalized AS (
  SELECT
    source, id, original, digits,
    CASE
      WHEN digits ~ '^\+27[1-8][0-9]{8}$' THEN digits
      WHEN digits ~ '^27[1-8][0-9]{8}$'   THEN '+' || digits
      WHEN digits ~ '^0[1-8][0-9]{8}$'    THEN '+27' || substring(digits FROM 2)
      ELSE NULL
    END AS normalized
  FROM cleaned
)
SELECT
  source,
  id,
  regexp_replace(original, '\d', '•', 'g') AS masked,
  length(original)                          AS original_len,
  CASE
    WHEN normalized IS NULL          THEN 'WILL_NULL'
    WHEN normalized = original       THEN 'already_ok'
    ELSE                                  'will_update'
  END AS status
FROM normalized
ORDER BY
  CASE
    WHEN normalized IS NULL          THEN 0
    WHEN normalized = original       THEN 2
    ELSE                                  1
  END,
  source, id;

-- Summary count
WITH src AS (
  SELECT 'profiles'  AS source, phone FROM profiles  WHERE phone IS NOT NULL AND phone <> ''
  UNION ALL
  SELECT 'practices' AS source, phone FROM practices WHERE phone IS NOT NULL AND phone <> ''
),
cleaned AS (
  SELECT source, regexp_replace(phone, '[\s\-()]', '', 'g') AS digits, phone AS original FROM src
),
normalized AS (
  SELECT
    source, original,
    CASE
      WHEN digits ~ '^\+27[1-8][0-9]{8}$' THEN digits
      WHEN digits ~ '^27[1-8][0-9]{8}$'   THEN '+' || digits
      WHEN digits ~ '^0[1-8][0-9]{8}$'    THEN '+27' || substring(digits FROM 2)
      ELSE NULL
    END AS normalized
  FROM cleaned
)
SELECT
  source,
  count(*) FILTER (WHERE normalized IS NULL)                              AS will_null,
  count(*) FILTER (WHERE normalized IS NOT NULL AND normalized = original) AS already_ok,
  count(*) FILTER (WHERE normalized IS NOT NULL AND normalized <> original) AS will_update,
  count(*)                                                                 AS total
FROM normalized
GROUP BY source
ORDER BY source;
