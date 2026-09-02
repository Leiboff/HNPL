-- ─── The repo catches up with production (audit R3-08) ──────────────────
--
-- THE DEFECT
--
-- Replaying every migration in version order produces 119 policies. The live
-- database has 120, and three did not match:
--
--   plans      migrations: practice_members_select_plans
--              production:  practice_admins_select_plans
--   payments   migrations: practice_members_select_payments
--              production:  practice_admins_select_payments
--   payments   migrations: —
--              production:  provider_select_own_payments
--
-- A grep for CREATE/DROP POLICY across every migration confirms the three
-- production names appear NOWHERE in this repository. They were created by
-- hand — dashboard or psql — and never written back.
--
-- The hand-edit went the SAFE way: is_practice_admin is strictly narrower
-- than is_practice_member, so production is tighter than the repo. That is
-- what makes it worth fixing rather than shrugging at — THE REPOSITORY IS
-- THE INSECURE VERSION. A `supabase db reset`, a new staging project or a
-- disaster-recovery rebuild would have silently reinstated
-- practice_members_select_*, under which any active practice member —
-- including role='staff' — reads every plan and payment for their practice.
-- The recovery path downgraded the security posture, quietly.
--
-- This migration makes the repo reproduce production, so that stops being
-- true. Written idempotently (DROP IF EXISTS on all five names before
-- CREATE) so it is a no-op against production, where the three already
-- exist, and a real change against anything built from migrations.
--
-- ─── THE ONE PLACE THIS IS NOT A VERBATIM ADOPTION ──────────────────────
--
-- `provider_select_own_payments` is adopted with its predicate MODERNISED,
-- and that is a deliberate behaviour change rather than a transcription.
-- The reason is written down in 0094 itself:
--
--     -- ── 5. The RLS predicates that keyed on provider_id = auth.uid() ──
--     -- Two policies did, and BOTH have to move or a provider silently
--     -- loses access to their own data the moment the app starts writing
--     -- provider_member_id:
--     --   0022  provider_select_own_plans            ON plans
--     --   0093  provider_select_own_patient_profiles ON profiles
--
-- There were THREE. `provider_select_own_payments` keys on the same legacy
-- `plans.provider_id = auth.uid()`, and 0094 did not move it — because it is
-- not in any migration, so 0094's author could not see it. The drift did not
-- merely hide a policy; it caused a later migration to miss one it had
-- explicitly set out to fix.
--
-- 0094 also states what the move was FOR, and that half is still not true of
-- payments today:
--
--     -- The helper checks active = true, which the old `provider_id =
--     -- auth.uid()` predicate could not express. That is a deliberate
--     -- TIGHTENING: … the stated guarantee is that a provider loses access
--     -- when their membership is deactivated.
--
-- So on production right now, a deactivated practitioner still reads the
-- payments of every plan they were the provider on. Adopting the policy
-- verbatim would write that into the repo as though it were intended.
--
-- The tightening is applied here instead, which is the smallest change that
-- leaves plans, profiles and payments all saying the same thing. It costs
-- nothing to do now and is not reversible cheaply later: `plans` currently
-- holds ZERO rows, so no practitioner's access changes today.
--
-- If that is the wrong call, the fix is to replace the predicate in section
-- 3 below with the verbatim production form:
--
--     EXISTS (SELECT 1 FROM plans
--              WHERE plans.id = payments.plan_id
--                AND plans.provider_id = auth.uid())
--
-- ─── AND THE RULE THAT FOLLOWS FROM ALL THIS ────────────────────────────
--
-- No hand-edits to RLS. The drift was only detectable because somebody went
-- looking with lib/security/schemaInvariants.ts; nothing about the running
-- system was wrong in a way anyone would have noticed. A policy changed in
-- the dashboard is a policy that survives exactly until the next rebuild.

-- ── 1. plans — the practice-side SELECT narrows to practice admins ──────
--
-- is_practice_admin(practice_id) rather than is_practice_member: a bill is
-- visible to whoever runs the practice, not to every active member of it.

DROP POLICY IF EXISTS "practice_members_select_plans" ON plans;
DROP POLICY IF EXISTS "practice_admins_select_plans"  ON plans;

CREATE POLICY "practice_admins_select_plans" ON plans
  FOR SELECT USING (is_practice_admin(practice_id));

-- ── 2. payments — same narrowing, resolved through the plan ─────────────

DROP POLICY IF EXISTS "practice_members_select_payments" ON payments;
DROP POLICY IF EXISTS "practice_admins_select_payments"  ON payments;

CREATE POLICY "practice_admins_select_payments" ON payments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM plans
       WHERE plans.id = payments.plan_id
         AND is_practice_admin(plans.practice_id)
    )
  );

-- ── 3. payments — the treating practitioner, on the 0094 model ──────────
--
-- See the header: production has this policy keyed on the legacy
-- `plans.provider_id`, which 0094 moved away from everywhere it could see.
-- `is_own_active_membership` is the helper 0094 introduced for exactly this
-- predicate, and it is SECURITY DEFINER so the membership lookup does not
-- inherit practice_members' own RLS.

DROP POLICY IF EXISTS "provider_select_own_payments" ON payments;

CREATE POLICY "provider_select_own_payments" ON payments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM plans
       WHERE plans.id = payments.plan_id
         AND is_own_active_membership(plans.provider_member_id)
    )
  );

COMMENT ON TABLE payments IS
  'Instalment and settlement rows. SELECT is visible to the patient who owes '
  'it, the admins of the practice that raised it, the treating practitioner '
  'through their ACTIVE membership (0094''s model, applied here by 0136), the '
  'brand admin of the practice''s group, and platform admins. All writes go '
  'through protect_payments_write. The three practice-side policies were '
  'reconciled from hand-made production state in 0136 — see audit R3-08.';
