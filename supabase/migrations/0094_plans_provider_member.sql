-- ─── plans: attribute bills to a MEMBERSHIP, not a login ──────────────────
--
-- WHY
-- ───
-- plans.provider_id referenced profiles(id) — i.e. an auth user. A roster-only
-- practitioner (name + specialty + HPCSA, no login; migration 0091) has no
-- profiles row at all, so they could not be attached to a bill. The roster
-- feature was therefore only half-useful: you could record a practitioner and
-- then not bill for them.
--
-- The fix is to attribute a plan to the thing that always exists and never
-- changes identity: the practice_members row.
--
-- WHY REPOINT RATHER THAN ADD A SECOND COLUMN
-- ───────────────────────────────────────────
-- The alternative was to keep provider_id and add provider_member_id beside
-- it with a CHECK that exactly one is set. The deciding case rules it out:
--
--   A bill is issued to a roster-only practitioner. They are LATER invited
--   and given a login. They must still see that earlier bill.
--
-- inviteLoginForRosterMember (lib/brand/inviteMember.ts) UPDATEs the EXISTING
-- practice_members row — `.eq('id', input.memberId)` — setting user_id and
-- clearing the local name columns. It does not create a second row. So the
-- membership id is STABLE across the login transition, and a plan pointing at
-- it resolves to that person before and after the invite with no backfill and
-- no migration of the plan row at all.
--
-- Under the two-column design the same person's identity would have to MIGRATE
-- from provider_member_id to provider_id mid-life, which means either
-- rewriting historical plans on invite (a backfill that can miss rows, and the
-- exact failure this migration exists to avoid) or teaching every consumer,
-- and both RLS policies, to check two columns forever. One stable pointer is
-- strictly better, so provider_member_id becomes the single live link.
--
-- WHAT HAPPENS TO provider_id
-- ───────────────────────────
-- It is NOT dropped here. After this migration nothing reads it — every
-- consumer moves to provider_member_id in the same commit — but the old value
-- is the only evidence available for reconciling a backfill that turns out
-- wrong, and dropping a column in the same deploy as the code that stops using
-- it removes the ability to check. A later migration drops it once the
-- backfill has been verified in production. Marked deprecated via COMMENT so
-- nobody re-adopts it in the meantime.
--
-- Its FK to profiles(id) with ON DELETE RESTRICT (0045) also stays, which is
-- deliberate: it keeps preventing a profile delete from silently orphaning
-- historical attribution while the column still holds data.

-- ── 1. The new link ─────────────────────────────────────────────────────

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS provider_member_id UUID REFERENCES practice_members(id);

-- ── 2. Backfill ─────────────────────────────────────────────────────────
--
-- The join is UNAMBIGUOUS BY CONSTRAINT, not by luck: practice_members has
-- carried UNIQUE (practice_id, user_id) since 0001 and no migration has ever
-- dropped it, so (plan.practice_id, plan.provider_id) matches AT MOST ONE
-- membership row. Roster rows have user_id IS NULL and the constraint uses the
-- default NULLS DISTINCT, so they neither collide with each other nor can they
-- be matched by this UPDATE.
--
-- Deliberately NOT filtered on pm.active: a bill raised by a practitioner who
-- has since been deactivated must keep its attribution. Access is a separate
-- question, decided by the policies in step 4.

UPDATE plans
   SET provider_member_id = pm.id
  FROM practice_members pm
 WHERE pm.practice_id = plans.practice_id
   AND pm.user_id     = plans.provider_id
   AND plans.provider_id IS NOT NULL
   AND plans.provider_member_id IS NULL;

-- ── 3. Verify the backfill left nothing behind ──────────────────────────
--
-- A plan can have a non-null provider_id that resolves to no membership at its
-- own practice — e.g. the membership row was deleted, or the plan's practice_id
-- was changed. Those rows would silently lose their provider attribution.
--
-- This RAISES rather than logging a notice. Losing the record of which
-- practitioner a bill belongs to is not something a migration should do
-- quietly, and a failed migration is recoverable in a way that silent data
-- loss is not. If this fires, inspect the listed plans and decide per row.

DO $$
DECLARE
  unresolved_count INT;
  sample_ids       TEXT;
BEGIN
  SELECT count(*) INTO unresolved_count
    FROM plans
   WHERE provider_id IS NOT NULL
     AND provider_member_id IS NULL;

  IF unresolved_count > 0 THEN
    SELECT string_agg(id::text, ', ' ORDER BY id) INTO sample_ids
      FROM (
        SELECT id FROM plans
         WHERE provider_id IS NOT NULL
           AND provider_member_id IS NULL
         ORDER BY id
         LIMIT 20
      ) t;

    RAISE EXCEPTION
      'Backfill incomplete: % plan(s) have provider_id set but no matching practice_members row at their own practice. First up to 20 ids: %. Resolve these before re-running — each needs a decision about which membership (if any) the bill belongs to.',
      unresolved_count, sample_ids;
  END IF;
END $$;

-- ── 4. Index ────────────────────────────────────────────────────────────
-- Both the /provider own-bills view and the new plans policy filter on this.

CREATE INDEX IF NOT EXISTS plans_provider_member_id_idx
  ON plans (provider_member_id)
  WHERE provider_member_id IS NOT NULL;

-- ── 5. The RLS predicates that keyed on provider_id = auth.uid() ────────
--
-- Two policies did, and BOTH have to move or a provider silently loses access
-- to their own data the moment the app starts writing provider_member_id:
--
--   0022  provider_select_own_plans            ON plans
--   0093  provider_select_own_patient_profiles ON profiles
--
-- A SECURITY DEFINER helper does the membership lookup rather than an inline
-- subquery. practice_members has its own RLS, and a subquery inside a policy
-- is subject to it — members_select_own_membership (0002) would happen to make
-- this work, but relying on one table's policy set to keep another table's
-- policy correct is the sort of coupling that breaks silently later. 0002
-- established exactly this convention and says so in its own comments.
--
-- The helper checks active = true, which the old `provider_id = auth.uid()`
-- predicate could not express. That is a deliberate TIGHTENING: /provider
-- already gates on an active membership in application code, and the stated
-- guarantee is that a provider loses access when their membership is
-- deactivated. It is now enforced in the database rather than only in the page.

CREATE OR REPLACE FUNCTION is_own_active_membership(p_member_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM practice_members
    WHERE id      = p_member_id
      AND user_id = auth.uid()
      AND active  = true
  );
$$;

COMMENT ON FUNCTION is_own_active_membership(UUID) IS
  'True when the given practice_members row belongs to the caller AND is active. SECURITY DEFINER so policies on other tables can resolve a membership without inheriting practice_members'' own RLS. Used by provider_select_own_plans (plans) and provider_select_own_patient_profiles (profiles).';

DROP POLICY IF EXISTS "provider_select_own_plans" ON plans;

CREATE POLICY "provider_select_own_plans"
  ON plans
  FOR SELECT
  USING (is_own_active_membership(provider_member_id));

COMMENT ON POLICY "provider_select_own_plans" ON plans IS
  'A practitioner may read the plans attributed to their own ACTIVE membership. Was provider_id = auth.uid() (0022); repointed in 0094 when attribution moved to practice_members so roster practitioners (no login) can be billed for. The active check is new and intentional.';

-- 0093's provider-side patient-profile policy, same repoint. The practice-side
-- policy (practice_admins_select_patient_profiles) does NOT reference
-- provider_id and is deliberately left exactly as 0093 created it.
DROP POLICY IF EXISTS "provider_select_own_patient_profiles" ON profiles;

CREATE POLICY "provider_select_own_patient_profiles"
  ON profiles
  FOR SELECT
  USING (
    role = 'patient'
    AND EXISTS (
      SELECT 1 FROM plans
      WHERE plans.patient_id = profiles.id
        AND is_own_active_membership(plans.provider_member_id)
    )
  );

COMMENT ON POLICY "provider_select_own_patient_profiles" ON profiles IS
  'A practitioner may read the profile of a patient on a plan attributed to their own ACTIVE membership. Correlated via plans.patient_id = profiles.id, so it grants nothing for patients they are not treating. Was plans.provider_id = auth.uid() (0093); repointed in 0094 alongside plans.provider_member_id.';

-- ── 6. Deprecate the old column ─────────────────────────────────────────

COMMENT ON COLUMN plans.provider_id IS
  'DEPRECATED as of 0094 — do not read or write. Attribution moved to plans.provider_member_id (practice_members.id) so that roster practitioners without a login can be billed for. Retained only as backfill evidence; a later migration drops it once 0094''s backfill is verified in production.';

COMMENT ON COLUMN plans.provider_member_id IS
  'The practice_members row of the treating practitioner. Stable across the roster→login transition, because inviteLoginForRosterMember updates that same row rather than creating a new one. NULL is permitted: plans predating 0021 have no provider, and the bill forms require one only going forward.';
