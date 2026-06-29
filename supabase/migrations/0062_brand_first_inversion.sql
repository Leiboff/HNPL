-- ─── Brand-first inversion (Phase 2) ─────────────────────────────────────
--
-- Every practice now belongs to a brand (practice_groups). Solo
-- practice = brand with n=1 practice. The "standalone" tier introduced
-- by 0061 (group_id IS NULL) is going away.
--
-- Why:
--   Phase 1 made the brand layer additive — group_id was nullable, and
--   a NULL group_id meant "standalone, treat as before". The product
--   shape has now flipped: every customer account is rooted at a
--   brand; whether the brand has one practice (the solo case) or
--   many is a UX concern, not a data concern. Inverting now lets every
--   downstream surface (banking resolution, RLS, approval queue,
--   discovery, settlement) speak one model.
--
-- This migration:
--   1. BACKFILLS a brand for every practice with NULL group_id. The
--      brand inherits the practice's name (best default we have without
--      asking the user) and is created `active`. The practice's
--      owner_id is granted brand_admin of the new brand so the human
--      who signed up keeps full agency over their (now auto-created)
--      brand.
--   2. ALTERs practices.group_id to NOT NULL.
--   3. Drops the partial index (group_id IS NOT NULL was the predicate;
--      every row qualifies now) and replaces it with a plain btree
--      index — the lookup pattern is unchanged but the predicate is
--      no longer useful.
--
-- Safety / idempotency:
--   • Backfill is keyed on practices.id, so re-running the INSERT does
--     nothing for already-grouped practices.
--   • practice_group_members upsert is keyed on (group_id, user_id)
--     UNIQUE — re-running re-activates rather than duplicates.
--   • NOT NULL is safe ONLY after the backfill — order matters; do not
--     reorder steps.
--   • is_brand_admin_of_practice() retains the `p.group_id IS NOT NULL`
--     guard. It's logically a no-op post-migration but stays as a
--     belt-and-braces against any pre-NOT-NULL transitional state in
--     a snapshot/restore scenario.
--
-- CHECK constraints: this migration adds none. Constraint widening
-- elsewhere (notably the role superset on practice_group_members) is
-- governed by 0061. No new CHECK lists are introduced here.

-- ── 1. Backfill: every standalone practice gets a 1-practice brand ──────

DO $$
DECLARE
  r RECORD;
  new_group_id UUID;
BEGIN
  FOR r IN
    SELECT id, name, owner_id
      FROM practices
     WHERE group_id IS NULL
  LOOP
    -- Create the brand (named after the practice — the human can
    -- rename it later from /brand).
    INSERT INTO practice_groups (name, status)
    VALUES (r.name, 'active')
    RETURNING id INTO new_group_id;

    -- Wire the practice into its new brand.
    UPDATE practices
       SET group_id = new_group_id
     WHERE id = r.id;

    -- Grant the practice owner (the human who signed up) brand_admin
    -- of the new brand. Upsert so re-running won't dupe.
    IF r.owner_id IS NOT NULL THEN
      INSERT INTO practice_group_members (group_id, user_id, role, active)
      VALUES (new_group_id, r.owner_id, 'brand_admin', true)
      ON CONFLICT (group_id, user_id) DO UPDATE
        SET active = true,
            role   = 'brand_admin';
    END IF;
  END LOOP;
END $$;

-- ── 2. Enforce NOT NULL on practices.group_id ───────────────────────────
--
-- After backfill, every practice row has a group_id. This is the
-- byte-for-byte guarantee for all downstream code: "group_id is always
-- set". Any new practice INSERT that omits group_id will now fail at
-- the DB layer — the brand-first signup action takes care of it.

ALTER TABLE practices
  ALTER COLUMN group_id SET NOT NULL;

-- ── 3. Replace partial index with a plain btree index ───────────────────
--
-- The partial index (WHERE group_id IS NOT NULL) was designed for the
-- additive-Phase-1 era when most rows had NULL group_id. Now every
-- row qualifies, so the predicate is dead weight.

DROP INDEX IF EXISTS practices_group_id_idx;
CREATE INDEX IF NOT EXISTS practices_group_id_idx
  ON practices (group_id);
