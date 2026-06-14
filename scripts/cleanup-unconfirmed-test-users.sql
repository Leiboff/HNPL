-- ─── One-shot: delete unconfirmed jnleiboff test auth users ────────────────
--
-- Paste this whole file into the Supabase web SQL Editor and click Run.
-- Three phases inside one transaction; the script ends with ROLLBACK so
-- the first run is a dry-run. Flip ROLLBACK → COMMIT after reviewing the
-- preview output and the deletion counts.
--
-- TARGET FILTER (intentionally narrow — adjust the LIKE before running
-- if you're cleaning up a different tester pattern):
--
--   email LIKE '%jnleiboff%'
--   AND email_confirmed_at IS NULL
--
-- DELETION ORDER (deepest leaves first; respects every FK chain that
-- could otherwise abort the delete with a 23503 violation):
--
--    1. plan_events            (refs plans, profiles)
--    2. payments               (refs plans, profiles)
--    3. payouts                (refs plans, practices, profiles)
--    4. refunds                (refs profiles)
--    5. patient_invitations    (refs plans, practices, profiles)
--    6. plans                  (refs applications, practices, profiles)
--    7. applications           (refs practices, profiles)
--    8. payment_methods        (refs profiles)
--    9. practice_members       (refs practices, profiles)
--   10. practices              (refs profiles)
--   11. profiles               (refs auth.users)
--   12. auth.users             (root)
--
-- This differs from the listed "applications → payments → payouts →
-- refunds → plans → plan_events → ..." ordering in two specific places:
--   • plan_events / payments must die BEFORE plans, not after, because
--     both have plan_id → plans(id) without ON DELETE CASCADE on the
--     profiles-targeted side.
--   • applications must die AFTER plans, because plans.application_id
--     → applications(id) is NO ACTION; deleting applications while a
--     plan still references one would fail with 23503.
--
-- POLICY NOTE: ONCE migration 0045 is applied (per-FK ON DELETE),
-- attempting to delete a profile that still has any plans / payments /
-- payouts / refunds / applications row will RAISE — that's intentional
-- for non-test users (POPIA-compliant retention of financial records).
-- This script is only safe for UNCONFIRMED tester rows because, by
-- definition, those users never had a verified session and therefore
-- shouldn't have any real financial activity. The defensive ordering
-- below covers the case where someone manually inserted test rows
-- pre-verification.

BEGIN;

-- ── PHASE 1: PREVIEW ────────────────────────────────────────────────────────
-- One row per target user, plus per-table counts of rows that the
-- destructive phase will touch.

SELECT
  u.id                                                              AS user_id,
  u.email,
  u.created_at,
  u.email_confirmed_at,
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)        AS has_profile,
  (SELECT count(*) FROM public.practices            WHERE owner_id   = u.id) AS owned_practices,
  (SELECT count(*) FROM public.practice_members     WHERE user_id    = u.id) AS memberships,
  (SELECT count(*) FROM public.payment_methods      WHERE patient_id = u.id) AS payment_methods,
  (SELECT count(*) FROM public.applications         WHERE patient_id = u.id) AS applications,
  (SELECT count(*) FROM public.plans                WHERE patient_id = u.id OR provider_id = u.id) AS plans,
  (SELECT count(*) FROM public.payments             WHERE patient_id = u.id) AS payments,
  (SELECT count(*) FROM public.payouts              WHERE provider_id = u.id) AS payouts,
  (SELECT count(*) FROM public.refunds              WHERE patient_id = u.id) AS refunds,
  (SELECT count(*) FROM public.plan_events          WHERE patient_id = u.id) AS plan_events,
  (SELECT count(*) FROM public.patient_invitations  WHERE provider_id = u.id) AS sent_invitations
FROM auth.users u
WHERE u.email LIKE '%jnleiboff%'
  AND u.email_confirmed_at IS NULL
ORDER BY u.created_at DESC;

-- Third-party member rows on a target practice (if anyone else was added).
SELECT
  pm.practice_id,
  pm.user_id     AS other_member_user_id,
  pm.role,
  pm.active
FROM public.practice_members pm
WHERE pm.practice_id IN (
  SELECT p.id FROM public.practices p
  JOIN auth.users u ON u.id = p.owner_id
  WHERE u.email LIKE '%jnleiboff%' AND u.email_confirmed_at IS NULL
)
AND pm.user_id NOT IN (
  SELECT id FROM auth.users
  WHERE email LIKE '%jnleiboff%' AND email_confirmed_at IS NULL
);

-- ── PHASE 2: DESTRUCTIVE DELETE ─────────────────────────────────────────────
-- All deletes in one DO block. Target sets are captured into TEMP tables
-- up front so every DELETE references the SAME id set even if rows are
-- inserted in parallel.

DO $$
DECLARE
  v_pe_count   int;  -- plan_events
  v_pay_count  int;  -- payments
  v_po_count   int;  -- payouts
  v_ref_count  int;  -- refunds
  v_inv_count  int;  -- patient_invitations
  v_pl_count   int;  -- plans
  v_app_count  int;  -- applications
  v_pm_count   int;  -- payment_methods
  v_mem_count  int;  -- practice_members
  v_prac_count int;  -- practices
  v_prof_count int;  -- profiles
  v_auth_count int;  -- auth.users
BEGIN
  -- Snapshot the target set.
  CREATE TEMP TABLE _cleanup_users ON COMMIT DROP AS
    SELECT id FROM auth.users
    WHERE email LIKE '%jnleiboff%'
      AND email_confirmed_at IS NULL;

  -- Target practices derived from target users (owner_id IN ...).
  CREATE TEMP TABLE _cleanup_practices ON COMMIT DROP AS
    SELECT id FROM public.practices
    WHERE owner_id IN (SELECT id FROM _cleanup_users);

  -- Target plans derived from target users / practices. Captured here so
  -- the payments / payouts / patient_invitations DELETEs below see the
  -- same plan ids even after plans gets deleted.
  CREATE TEMP TABLE _cleanup_plans ON COMMIT DROP AS
    SELECT id FROM public.plans
    WHERE patient_id  IN (SELECT id FROM _cleanup_users)
       OR provider_id IN (SELECT id FROM _cleanup_users)
       OR practice_id IN (SELECT id FROM _cleanup_practices);

  -- 1. plan_events
  DELETE FROM public.plan_events
  WHERE patient_id IN (SELECT id FROM _cleanup_users)
     OR plan_id    IN (SELECT id FROM _cleanup_plans);
  GET DIAGNOSTICS v_pe_count = ROW_COUNT;

  -- 2. payments
  DELETE FROM public.payments
  WHERE patient_id IN (SELECT id FROM _cleanup_users)
     OR plan_id    IN (SELECT id FROM _cleanup_plans);
  GET DIAGNOSTICS v_pay_count = ROW_COUNT;

  -- 3. payouts
  DELETE FROM public.payouts
  WHERE provider_id IN (SELECT id FROM _cleanup_users)
     OR plan_id     IN (SELECT id FROM _cleanup_plans)
     OR practice_id IN (SELECT id FROM _cleanup_practices);
  GET DIAGNOSTICS v_po_count = ROW_COUNT;

  -- 4. refunds
  DELETE FROM public.refunds
  WHERE patient_id IN (SELECT id FROM _cleanup_users);
  GET DIAGNOSTICS v_ref_count = ROW_COUNT;

  -- 5. patient_invitations
  DELETE FROM public.patient_invitations
  WHERE provider_id IN (SELECT id FROM _cleanup_users)
     OR plan_id     IN (SELECT id FROM _cleanup_plans)
     OR practice_id IN (SELECT id FROM _cleanup_practices);
  GET DIAGNOSTICS v_inv_count = ROW_COUNT;

  -- 6. plans
  DELETE FROM public.plans
  WHERE id IN (SELECT id FROM _cleanup_plans);
  GET DIAGNOSTICS v_pl_count = ROW_COUNT;

  -- 7. applications
  DELETE FROM public.applications
  WHERE patient_id  IN (SELECT id FROM _cleanup_users)
     OR practice_id IN (SELECT id FROM _cleanup_practices);
  GET DIAGNOSTICS v_app_count = ROW_COUNT;

  -- 8. payment_methods
  DELETE FROM public.payment_methods
  WHERE patient_id IN (SELECT id FROM _cleanup_users);
  GET DIAGNOSTICS v_pm_count = ROW_COUNT;

  -- 9. practice_members (OR covers third-party members on a target practice)
  DELETE FROM public.practice_members
  WHERE user_id     IN (SELECT id FROM _cleanup_users)
     OR practice_id IN (SELECT id FROM _cleanup_practices);
  GET DIAGNOSTICS v_mem_count = ROW_COUNT;

  -- 10. practices
  DELETE FROM public.practices
  WHERE id IN (SELECT id FROM _cleanup_practices);
  GET DIAGNOSTICS v_prac_count = ROW_COUNT;

  -- 11. profiles
  DELETE FROM public.profiles
  WHERE id IN (SELECT id FROM _cleanup_users);
  GET DIAGNOSTICS v_prof_count = ROW_COUNT;

  -- 12. auth.users
  DELETE FROM auth.users
  WHERE id IN (SELECT id FROM _cleanup_users);
  GET DIAGNOSTICS v_auth_count = ROW_COUNT;

  RAISE NOTICE 'Deletions:';
  RAISE NOTICE '  plan_events          = %', v_pe_count;
  RAISE NOTICE '  payments             = %', v_pay_count;
  RAISE NOTICE '  payouts              = %', v_po_count;
  RAISE NOTICE '  refunds              = %', v_ref_count;
  RAISE NOTICE '  patient_invitations  = %', v_inv_count;
  RAISE NOTICE '  plans                = %', v_pl_count;
  RAISE NOTICE '  applications         = %', v_app_count;
  RAISE NOTICE '  payment_methods      = %', v_pm_count;
  RAISE NOTICE '  practice_members     = %', v_mem_count;
  RAISE NOTICE '  practices            = %', v_prac_count;
  RAISE NOTICE '  profiles             = %', v_prof_count;
  RAISE NOTICE '  auth.users           = %', v_auth_count;
END $$;

-- ── PHASE 3: POST-CHECK ─────────────────────────────────────────────────────
-- Every block should return zero rows. If anything surfaces, the ROLLBACK
-- at the end undoes the deletes — investigate what slipped through before
-- flipping to COMMIT.

SELECT 'auth.users still matching filter:' AS check, id, email, email_confirmed_at
FROM auth.users
WHERE email LIKE '%jnleiboff%' AND email_confirmed_at IS NULL;

SELECT 'practices with no matching owner:' AS check, p.id, p.name, p.owner_id
FROM public.practices p
LEFT JOIN auth.users u ON u.id = p.owner_id
WHERE u.id IS NULL
  AND p.created_at > NOW() - INTERVAL '30 days';

SELECT 'practice_members pointing at no auth user:' AS check, pm.practice_id, pm.user_id, pm.role
FROM public.practice_members pm
LEFT JOIN auth.users u ON u.id = pm.user_id
WHERE u.id IS NULL
  AND pm.created_at > NOW() - INTERVAL '30 days';

SELECT 'profiles with no matching auth user:' AS check, pr.id, pr.email
FROM public.profiles pr
LEFT JOIN auth.users u ON u.id = pr.id
WHERE u.id IS NULL
  AND pr.created_at > NOW() - INTERVAL '30 days';

-- ── COMMIT or ROLLBACK ─────────────────────────────────────────────────────
-- First run: leave ROLLBACK to dry-run. Review the NOTICE counts and the
-- four post-check queries (all should return zero rows). If everything
-- looks right, flip to COMMIT and re-run the whole file to actually
-- persist the deletes.
ROLLBACK;
-- COMMIT;
