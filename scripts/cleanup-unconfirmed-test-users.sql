-- ─── One-shot: delete unconfirmed jnleiboff test auth users ────────────────
--
-- Paste this whole file into the Supabase web SQL Editor and click Run.
-- The script has two phases — read the preview BEFORE letting the
-- destructive block commit.
--
-- TARGETING FILTER (intentionally narrow):
--   email LIKE '%jnleiboff%'
--   AND email_confirmed_at IS NULL
--
-- These rows are by definition not "real users": they never completed
-- email verification. The LIKE pattern restricts the blast radius to your
-- personal tester address pattern. Adjust the LIKE before running if you
-- want to scope to a different tester pattern.
--
-- Order of deletion matters: profiles must go before auth.users because
-- profiles.id → auth.users(id) has no ON DELETE CASCADE today
-- (migration 0044, when applied, will fix that — at which point this
-- script could rely on the cascade. Until then, we delete manually.)
--
-- Wrapped in a single transaction. The preview SELECT runs first; if you
-- don't like what you see, change the WHERE clause or close the tab —
-- the COMMIT at the end is what actually persists the deletes.

BEGIN;

-- ── PHASE 1: PREVIEW ────────────────────────────────────────────────────────
-- Reports every auth.users row that the destructive block below will
-- touch, alongside whether a profile row exists for that id. Read this
-- carefully before proceeding.

SELECT
  u.id,
  u.email,
  u.created_at,
  u.email_confirmed_at,
  u.last_sign_in_at,
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id) AS has_profile_row
FROM auth.users u
WHERE u.email LIKE '%jnleiboff%'
  AND u.email_confirmed_at IS NULL
ORDER BY u.created_at DESC;

-- ── PHASE 2: DESTRUCTIVE DELETE ─────────────────────────────────────────────
-- Deletes the profile row first (FK-no-cascade workaround), then the
-- auth user. Counts are reported via RAISE NOTICE so you can sanity-check
-- against the preview row count above.

DO $$
DECLARE
  v_profile_count int;
  v_auth_count    int;
BEGIN
  WITH target AS (
    SELECT id FROM auth.users
    WHERE email LIKE '%jnleiboff%'
      AND email_confirmed_at IS NULL
  ),
  deleted_profiles AS (
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM target)
    RETURNING id
  )
  SELECT count(*) INTO v_profile_count FROM deleted_profiles;

  WITH deleted_users AS (
    DELETE FROM auth.users
    WHERE email LIKE '%jnleiboff%'
      AND email_confirmed_at IS NULL
    RETURNING id
  )
  SELECT count(*) INTO v_auth_count FROM deleted_users;

  RAISE NOTICE 'profiles deleted: % | auth.users deleted: %',
    v_profile_count, v_auth_count;
END $$;

-- ── PHASE 3: POST-CHECK ─────────────────────────────────────────────────────
-- Confirms no matching rows survive. Should return zero rows.

SELECT id, email, email_confirmed_at
FROM auth.users
WHERE email LIKE '%jnleiboff%'
  AND email_confirmed_at IS NULL;

-- Change ROLLBACK to COMMIT after you've reviewed the preview output and
-- want to actually delete. Until you do, this whole transaction is a
-- read-only dry-run.
ROLLBACK;
-- COMMIT;
