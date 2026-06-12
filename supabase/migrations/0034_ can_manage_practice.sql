-- Adds the can_manage_practice capability column to practice_members, backfills
-- existing admin-role members, and defines the is_practice_manager() helper.
--
-- PURELY ADDITIVE: no existing RLS policy or app code is changed. is_practice_admin()
-- remains in full effect. is_practice_manager() is defined but not yet referenced.

-- ── 1. Add column ─────────────────────────────────────────────────────────────

ALTER TABLE practice_members
  ADD COLUMN IF NOT EXISTS can_manage_practice BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Backfill ───────────────────────────────────────────────────────────────
-- Existing admin-role members keep their management power when Phase 2 wires
-- enforcement through this column instead of role = 'admin'.

UPDATE practice_members
  SET can_manage_practice = true
  WHERE role = 'admin';

-- ── 3. Helper function ────────────────────────────────────────────────────────
-- Mirrors is_practice_admin() exactly, substituting the capability column check.

CREATE OR REPLACE FUNCTION is_practice_manager(p_practice_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM practice_members
    WHERE practice_id = p_practice_id
      AND user_id = auth.uid()
      AND active = true
      AND can_manage_practice = true
  );
$$;