-- ─── Probe: what's the auth/profile state for an email? ────────────────────
--
-- Paste this whole file into the Supabase web SQL Editor and click Run.
--
-- BEFORE RUNNING: Find & Replace 'CHANGE_ME@example.com' (5 occurrences)
-- with the email you're testing with. Yes, five — one per query. This is
-- deliberately the most foolproof form: no psql meta-commands, no
-- set_config / current_setting (which depend on the editor's connection
-- and transaction handling), no CTEs needed.
--
-- Returns five result sections — flip between the result tabs:
--   1. auth.users row (if any)        — incl. email_confirmed_at + metadata
--   2. profiles row (if any)          — proves the 0024 trigger ran
--   3. practices owned by this user   — prior partial-signup leftovers
--   4. practice_members for this user — prior partial-signup leftovers
--   5. orphan diagnosis               — BOTH / AUTH_ONLY / PROFILE_ONLY / NEITHER

-- 1. auth.users
SELECT
  id,
  email,
  created_at,
  email_confirmed_at,
  last_sign_in_at,
  raw_user_meta_data
FROM auth.users
WHERE lower(email) = lower('CHANGE_ME@example.com');

-- 2. public.profiles
SELECT
  id,
  email,
  role,
  first_name,
  last_name,
  phone,
  created_at
FROM profiles
WHERE lower(email) = lower('CHANGE_ME@example.com');

-- 3. practices owned by this user
SELECT p.id, p.name, p.status, p.created_at
FROM practices p
JOIN auth.users u ON u.id = p.owner_id
WHERE lower(u.email) = lower('CHANGE_ME@example.com');

-- 4. practice_members for this user
SELECT pm.practice_id, pm.role, pm.active, pm.created_at
FROM practice_members pm
JOIN auth.users u ON u.id = pm.user_id
WHERE lower(u.email) = lower('CHANGE_ME@example.com');

-- 5. orphan diagnosis (one row)
SELECT
  CASE
    WHEN EXISTS (
      SELECT 1 FROM auth.users WHERE lower(email) = lower('CHANGE_ME@example.com')
    ) AND EXISTS (
      SELECT 1 FROM profiles WHERE lower(email) = lower('CHANGE_ME@example.com')
    ) THEN 'BOTH (normal — auth user and profile both present)'
    WHEN EXISTS (
      SELECT 1 FROM auth.users WHERE lower(email) = lower('CHANGE_ME@example.com')
    ) THEN 'AUTH_ONLY (orphan auth user — trigger failed OR profile manually deleted)'
    WHEN EXISTS (
      SELECT 1 FROM profiles WHERE lower(email) = lower('CHANGE_ME@example.com')
    ) THEN 'PROFILE_ONLY (orphan profile — partial rollback)'
    ELSE 'NEITHER (no record — safe to retry signup)'
  END AS diagnosis;
