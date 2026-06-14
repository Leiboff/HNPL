-- ─── Trading gate at the RLS layer ──────────────────────────────────────────
--
-- Defense-in-depth for the application-layer trading gate that lives in
-- lib/practice/tradingGate.ts. Before this migration, the INSERT policies
-- on applications / plans / payments only checked is_practice_member() —
-- meaning a freshly-signed-up pending-practice admin could open the
-- browser console and call `supabase.from('plans').insert(...)` directly
-- against PostgREST, bypassing the server action entirely.
--
-- We now require BOTH:
--   a. practices.status = 'approved'
--   b. >= 1 active practice_members row with role = 'provider'
-- for every direct insert into applications / plans / payments by a
-- user-token caller. Service-role bypasses RLS as usual, so internal
-- workers / admin tooling are unaffected.
--
-- The same two conditions live in lib/practice/tradingGate.ts. If either
-- side changes, the other must be updated to match.

-- ─── practice_can_trade(uuid) ───────────────────────────────────────────────
-- STABLE + SECURITY DEFINER so RLS on practices / practice_members doesn't
-- recurse into our own policies. Mirrors the is_practice_member() pattern.
CREATE OR REPLACE FUNCTION practice_can_trade(p_practice_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM practices
      WHERE id = p_practice_id AND status = 'approved'
    )
    AND EXISTS (
      SELECT 1 FROM practice_members
      WHERE practice_id = p_practice_id
        AND active = true
        AND role = 'provider'
    );
$$;

-- ─── Tighten the three INSERT policies ──────────────────────────────────────

DROP POLICY IF EXISTS "practice_members_insert_applications" ON applications;
CREATE POLICY "practice_members_insert_applications" ON applications
    FOR INSERT
    WITH CHECK (
        is_practice_member(practice_id)
        AND practice_can_trade(practice_id)
    );

DROP POLICY IF EXISTS "practice_members_insert_plans" ON plans;
CREATE POLICY "practice_members_insert_plans" ON plans
    FOR INSERT
    WITH CHECK (
        is_practice_member(practice_id)
        AND practice_can_trade(practice_id)
    );

DROP POLICY IF EXISTS "practice_members_insert_payments" ON payments;
CREATE POLICY "practice_members_insert_payments" ON payments
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM plans
            WHERE plans.id = payments.plan_id
              AND is_practice_member(plans.practice_id)
              AND practice_can_trade(plans.practice_id)
        )
    );

-- DELETE policies left untouched — rollback in createBill() must keep working.
