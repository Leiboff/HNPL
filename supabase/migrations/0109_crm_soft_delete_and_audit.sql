-- ─── CRM Phase 1.3 — soft delete + DB-level audit trail ───────────────
--
-- Correspondence is the point of this product and it is currently
-- destructible: the sales role holds DELETE on crm_leads, and
-- crm_audit_log is written only by application code (grep confirms
-- the only writers today are app/crm/admin/gmail-accounts/actions.ts
-- and app/api/crm/gmail/callback/route.ts — neither touches
-- crm_leads at all). Archiving replaces deletion in the product;
-- a trigger makes the audit trail unforgeable by a code path that
-- forgets to log.

-- ── 1. Soft-delete columns ────────────────────────────────────────────

ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS crm_leads_archived_idx
  ON crm_leads(archived_at)
  WHERE archived_at IS NOT NULL;

-- ── 2. Revoke sales DELETE; admin retains it ──────────────────────────

DROP POLICY IF EXISTS "crm_leads_admin_sales_delete" ON crm_leads;

CREATE POLICY "crm_leads_admin_delete"
  ON crm_leads FOR DELETE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  );

-- ── 3. DB-level audit trail on crm_leads ──────────────────────────────
--
-- AFTER INSERT/UPDATE/DELETE, unconditionally. Fires regardless of
-- which client/role/code-path made the change (server action, a
-- future admin script, a direct psql session under service_role) —
-- that's the entire point: the trail survives a caller that forgets
-- to log.

CREATE OR REPLACE FUNCTION crm_leads_audit_trail()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO crm_audit_log (actor_id, action, target_type, target_id, details)
    VALUES (v_actor, 'crm_leads.insert', 'crm_lead', NEW.id, to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO crm_audit_log (actor_id, action, target_type, target_id, details)
    VALUES (
      v_actor, 'crm_leads.update', 'crm_lead', NEW.id,
      jsonb_build_object('old', to_jsonb(OLD), 'new', to_jsonb(NEW))
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO crm_audit_log (actor_id, action, target_type, target_id, details)
    VALUES (v_actor, 'crm_leads.delete', 'crm_lead', OLD.id, to_jsonb(OLD));
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_leads_audit_trail ON crm_leads;
CREATE TRIGGER trg_crm_leads_audit_trail
  AFTER INSERT OR UPDATE OR DELETE ON crm_leads
  FOR EACH ROW
  EXECUTE FUNCTION crm_leads_audit_trail();

COMMENT ON COLUMN crm_leads.archived_at IS
  'Soft delete. Every lead-listing query (leads list, board, map, search, My Day) must filter WHERE archived_at IS NULL.';
