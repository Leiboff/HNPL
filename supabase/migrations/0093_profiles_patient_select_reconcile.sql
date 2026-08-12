-- ─── profiles patient-SELECT: back-port production's out-of-band fix ──────
--
-- WHY THIS MIGRATION EXISTS AT ALL
-- ───────────────────────────────
-- This migration changes NOTHING on production. It exists because the repo
-- and production had silently diverged, and production was the correct one.
--
-- 0006 created this policy on profiles:
--
--   CREATE POLICY "practice_members_select_patient_profiles" ON profiles
--     FOR SELECT USING (
--       role = 'patient'
--       AND EXISTS (SELECT 1 FROM practice_members pm
--                   WHERE pm.user_id = auth.uid() AND pm.active = true));
--
-- That EXISTS is UNCORRELATED — it never references profiles.id. It asks
-- "is the caller an active member of ANY practice", not "is the caller
-- related to THIS patient". Read literally, any active member of any
-- practice could SELECT every patient profile in the system: name, email,
-- phone. A cross-tenant read of personal health-adjacent data (POPIA).
--
-- Production does not have that policy. It has two correctly-scoped
-- replacements, both correlated through plans.patient_id = profiles.id.
-- Two independent live pg_policies queries with different filter clauses
-- returned byte-identical raw JSON confirming this.
--
-- NO MIGRATION IN THIS REPO CREATES, DROPS, OR RENAMES EITHER REPLACEMENT.
-- Verified by scanning all 92 prior migrations: 0006's CREATE is the only
-- statement that ever touches that policy name; there is no ALTER POLICY,
-- no RENAME TO, and no dynamic EXECUTE format policy DDL anywhere. So the
-- replacements were applied to production OUT OF BAND — the same failure
-- mode already found once with the archived-cards seed script.
--
-- The consequence, and the reason this is not merely bookkeeping: PRODUCTION
-- IS SAFE, THE REPO IS NOT. Any environment built from these migrations —
-- a fresh local DB, staging, a restored branch, a disaster-recovery rebuild
-- — resurrects the uncorrelated 0006 policy and reintroduces the
-- cross-tenant read. Nothing in the test suite would have caught it, because
-- neither corrected policy name appeared anywhere in the codebase.
--
-- WHAT THIS DOES
-- ──────────────
-- Brings the versioned migrations to production's actual state, so a fresh
-- environment matches production for the first time.
--
-- Net-state no-op on production. Note "net-state": the two CREATEs are
-- preceded by DROP ... IF EXISTS so the migration is idempotent (a bare
-- CREATE POLICY would error on production, where both already exist). On
-- production that means each policy is dropped and immediately recreated
-- with identical text. `supabase db push` runs each migration file in a
-- transaction, so there is no window in which a policy is missing.
--
-- The two policy bodies below are transcribed from the live pg_policies
-- `qual` output and normalize back to it exactly.
--
-- SELECT ONLY, PATIENT PROFILES ONLY
-- ──────────────────────────────────
-- No INSERT, UPDATE or DELETE policy is added, altered or dropped. Left
-- untouched and still in force (RLS policies are permissive/OR'd):
--   0002  users_select_own_profile            id = auth.uid()
--   0002  users_update_own_profile            id = auth.uid()
--   0002  admins_select_all_profiles          is_platform_admin()
--   0022  provider_select_own_profile         id = auth.uid()
--   0022  provider_update_own_profile         id = auth.uid()
--   0035  practice_admin_select_member_profiles  STAFF profiles, correlated
--         via practice_members target_member — already correctly scoped,
--         deliberately NOT touched here.
--
-- WHO CAN READ A PATIENT PROFILE AFTER THIS
-- ─────────────────────────────────────────
-- Note that the practice-side policy uses is_practice_admin (0002), which
-- is ROLE-based — an active practice_members row with role = 'admin'. It is
-- NOT is_practice_manager (0034, can_manage_practice = true). So a member
-- with the manage capability but without role = 'admin' does NOT get patient
-- profile reads from this policy. That is production's behaviour, reproduced
-- deliberately rather than "corrected" — this migration's job is to make the
-- repo match production, and changing the predicate at the same time would
-- destroy the only evidence of what production actually does.
--
-- The bill-creation patient lookup (app/practice/bills/new/actions.ts) uses
-- the SERVICE-ROLE client and bypasses RLS entirely, so it is unaffected by
-- any of this — which is also why the divergence stayed invisible for so
-- long: no user-visible flow depended on the broken policy.

-- ── 1. Remove 0006's uncorrelated policy ────────────────────────────────
-- IF EXISTS because production reached its current state without ever
-- having this policy under this path — there is nothing to drop there.

DROP POLICY IF EXISTS "practice_members_select_patient_profiles" ON profiles;

-- ── 2. The two correctly-scoped policies, as production has them ────────
-- Dropped first so this migration is re-runnable and so production (where
-- both already exist) does not error.

DROP POLICY IF EXISTS "practice_admins_select_patient_profiles" ON profiles;
DROP POLICY IF EXISTS "provider_select_own_patient_profiles"    ON profiles;

-- A practice admin may read the profile of a patient who has a plan AT
-- THEIR OWN PRACTICE. The EXISTS is correlated via plans.patient_id =
-- profiles.id, so it grants nothing for a patient with no plan at that
-- practice.
CREATE POLICY "practice_admins_select_patient_profiles" ON profiles
    FOR SELECT
    USING (
        role = 'patient'
        AND EXISTS (
            SELECT 1 FROM plans
            WHERE plans.patient_id = profiles.id
              AND is_practice_admin(plans.practice_id)
        )
    );

-- A provider may read the profile of a patient on a plan assigned to THEM
-- personally, at any practice they work at.
CREATE POLICY "provider_select_own_patient_profiles" ON profiles
    FOR SELECT
    USING (
        role = 'patient'
        AND EXISTS (
            SELECT 1 FROM plans
            WHERE plans.patient_id = profiles.id
              AND plans.provider_id = auth.uid()
        )
    );

-- ── 3. Documentation ────────────────────────────────────────────────────

COMMENT ON POLICY "practice_admins_select_patient_profiles" ON profiles IS
  'A practice admin (is_practice_admin = active practice_members row with role = ''admin'') may read the profile of a patient who has a plan at that practice. Correlated via plans.patient_id = profiles.id — a patient with no plan at the practice is not readable. Back-ported in 0093 from production, which had it out of band; replaces 0006''s practice_members_select_patient_profiles, whose EXISTS was uncorrelated and let any active member of any practice read every patient profile.';

COMMENT ON POLICY "provider_select_own_patient_profiles" ON profiles IS
  'A provider may read the profile of a patient on a plan where plans.provider_id = auth.uid(). Correlated to the specific plan, so it grants nothing for patients the provider is not treating. Back-ported in 0093 from production — see practice_admins_select_patient_profiles.';
