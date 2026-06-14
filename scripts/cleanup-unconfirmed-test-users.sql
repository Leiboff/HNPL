-- ─── One-shot: delete unconfirmed jnleiboff test auth users ────────────────
--
-- Paste this whole file into the Supabase web SQL Editor and click Run.
-- The script has three phases — read the preview output BEFORE you let
-- the destructive block commit.
--
-- TARGET FILTER (intentionally narrow — adjust the LIKE before running
-- if you're cleaning up a different tester pattern):
--
--   email LIKE '%jnleiboff%'
--   AND email_confirmed_at IS NULL
--
-- DEPENDENCY ORDER (bottom-up):
--   practice_members  → practices  → profiles  → auth.users
--
--   • practice_members.user_id   → profiles(id)
--   • practice_members.practice_id → practices(id)
--   • practices.owner_id         → profiles(id)
--   • profiles.id                → auth.users(id)
--
--   Some target users got further through signup than others, so any of
--   the three downstream tables may have rows. We clear all four.
--
--   Once migration 0044 (profiles.id ON DELETE CASCADE) is applied, the
--   profiles → auth.users step becomes implicit; the practice_members
--   and practices steps stay manual because no cascades touch those.
--
-- The whole script runs inside one transaction. The trailing statement
-- is ROLLBACK; — the first run is therefore a dry-run. Flip ROLLBACK
-- to COMMIT after you've reviewed the preview output.

BEGIN;

-- ── PHASE 1: PREVIEW ────────────────────────────────────────────────────────
-- One row per target auth user, with downstream row counts so you can see
-- exactly how far each orphan got through the signup pipeline.

SELECT
  u.id                                        AS user_id,
  u.email,
  u.created_at,
  u.email_confirmed_at,
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
                                              AS has_profile,
  (SELECT count(*) FROM public.practices         WHERE owner_id = u.id)
                                              AS owned_practices,
  (SELECT count(*) FROM public.practice_members WHERE user_id  = u.id)
                                              AS memberships
FROM auth.users u
WHERE u.email LIKE '%jnleiboff%'
  AND u.email_confirmed_at IS NULL
ORDER BY u.created_at DESC;

-- Also show any practice_members rows that point at OUR target practices
-- but were created by a different user (shouldn't exist in dev, but if
-- it does — e.g. you manually added a provider to a test practice — the
-- destructive block will clear them too via the OR clause).
SELECT
  pm.practice_id,
  pm.user_id     AS other_member_user_id,
  pm.role,
  pm.active
FROM public.practice_members pm
WHERE pm.practice_id IN (
  SELECT p.id FROM public.practices p
  JOIN auth.users u ON u.id = p.owner_id
  WHERE u.email LIKE '%jnleiboff%'
    AND u.email_confirmed_at IS NULL
)
AND pm.user_id NOT IN (
  SELECT id FROM auth.users
  WHERE email LIKE '%jnleiboff%'
    AND email_confirmed_at IS NULL
);

-- ── PHASE 2: DESTRUCTIVE DELETE ─────────────────────────────────────────────
-- Bottom-up. Counts per table reported via RAISE NOTICE. Stop and re-check
-- the preview if any count looks unexpectedly large.

DO $$
DECLARE
  v_pm_count    int;
  v_prac_count  int;
  v_prof_count  int;
  v_auth_count  int;
BEGIN
  -- 1. practice_members — every row that references a target user OR a
  --    practice owned by a target user. The OR catches the "other member
  --    of a target practice" edge case from the second preview SELECT.
  DELETE FROM public.practice_members
  WHERE user_id IN (
    SELECT id FROM auth.users
    WHERE email LIKE '%jnleiboff%'
      AND email_confirmed_at IS NULL
  )
  OR practice_id IN (
    SELECT p.id FROM public.practices p
    JOIN auth.users u ON u.id = p.owner_id
    WHERE u.email LIKE '%jnleiboff%'
      AND u.email_confirmed_at IS NULL
  );
  GET DIAGNOSTICS v_pm_count = ROW_COUNT;

  -- 2. practices — owned by any target user.
  DELETE FROM public.practices
  WHERE owner_id IN (
    SELECT id FROM auth.users
    WHERE email LIKE '%jnleiboff%'
      AND email_confirmed_at IS NULL
  );
  GET DIAGNOSTICS v_prac_count = ROW_COUNT;

  -- 3. profiles — id matches a target user.
  DELETE FROM public.profiles
  WHERE id IN (
    SELECT id FROM auth.users
    WHERE email LIKE '%jnleiboff%'
      AND email_confirmed_at IS NULL
  );
  GET DIAGNOSTICS v_prof_count = ROW_COUNT;

  -- 4. auth.users — last (no other FK references should remain).
  DELETE FROM auth.users
  WHERE email LIKE '%jnleiboff%'
    AND email_confirmed_at IS NULL;
  GET DIAGNOSTICS v_auth_count = ROW_COUNT;

  RAISE NOTICE 'Deleted: practice_members=%, practices=%, profiles=%, auth.users=%',
    v_pm_count, v_prac_count, v_prof_count, v_auth_count;
END $$;

-- ── PHASE 3: POST-CHECK ─────────────────────────────────────────────────────
-- Should return zero rows in every block. If any block returns rows, the
-- ROLLBACK at the end will undo the deletes — investigate why a downstream
-- row points at a target user that PHASE 2 didn't catch.

SELECT id, email, email_confirmed_at
FROM auth.users
WHERE email LIKE '%jnleiboff%'
  AND email_confirmed_at IS NULL;

SELECT p.id, p.name, p.owner_id
FROM public.practices p
LEFT JOIN auth.users u ON u.id = p.owner_id
WHERE u.id IS NULL
  AND p.created_at > NOW() - INTERVAL '30 days';   -- stranded recent practices

SELECT pm.practice_id, pm.user_id, pm.role
FROM public.practice_members pm
LEFT JOIN auth.users u ON u.id = pm.user_id
WHERE u.id IS NULL
  AND pm.created_at > NOW() - INTERVAL '30 days';  -- stranded recent memberships

-- ── COMMIT or ROLLBACK ─────────────────────────────────────────────────────
-- First run: leave ROLLBACK to dry-run. Review the NOTICE counts and the
-- post-check output. If both look right, flip to COMMIT and re-run the
-- whole file to actually persist.
ROLLBACK;
-- COMMIT;
