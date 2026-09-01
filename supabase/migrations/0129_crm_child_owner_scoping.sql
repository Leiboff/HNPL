-- ─── The CRM child tables inherit their lead's ownership ────────────────
--
-- THE DEFECT (audit 2026-09-02, A-09 and A-10)
--
-- 0113 deliberately narrowed `crm_leads` so a `sales` caller sees only rows
-- where `owner_user_id = auth.uid()`. Its CHILD tables were not narrowed with
-- it, and every one of them still reads:
--
--     USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','sales'))
--
-- So the parent row is hidden and the children are not — and the children are
-- the richer half. `crm_lead_contacts` carries practitioner names, direct
-- email addresses, cellphone numbers, HPCSA registration numbers,
-- decision-maker flags and interest levels. `crm_activities` carries the call
-- notes and the email bodies.
--
-- One request from any `sales` session took the whole prospect book:
--
--     GET    /rest/v1/crm_lead_contacts?select=*
--     GET    /rest/v1/crm_activities?select=*&order=created_at.desc
--     DELETE /rest/v1/crm_tasks?id=eq.<any>          ← another rep's pipeline
--
-- A departing rep's exfiltration looks like an ordinary authenticated read,
-- and `crm_audit_log` records writes, not reads.
--
-- A-10 is the smaller sibling: 0113's UPDATE policy on `crm_leads` scopes the
-- USING clause on ownership and then drops the predicate from WITH CHECK,
-- leaving only `role = 'sales'`. So the ROW a rep may write is scoped, but the
-- value they may write into `owner_user_id` is not — a rep can push a dead
-- lead onto a colleague's quota, or move one out of their own visibility
-- before it is audited. One-directional (the USING clause still blocks
-- pulling), so it is quota gaming rather than data exposure.
--
-- ─── THE FIX: ONE predicate, correlated through the parent ──────────────
--
-- `crm_can_see_lead(lead_id)` is the single definition of CRM visibility.
-- Every child policy is rewritten through it, so the next child table added
-- has an obvious right answer and the next change to the rule happens in one
-- place. That is the property 0113 was missing: it fixed the parent and left
-- seven tables to be remembered.
--
-- SECURITY DEFINER on the helper, deliberately. A `sales` caller cannot
-- SELECT another rep's `crm_leads` row — that is the whole point of 0113 —
-- so an invoker-rights helper would return false for a lead the caller
-- legitimately owns whenever the policy is evaluated in a context that has
-- already been narrowed. Definer rights let it answer the ownership question
-- truthfully; it returns a BOOLEAN and never a row, so it leaks nothing.
--
-- ─── THE THREE TABLES THAT ARE NOT LEAD-SCOPED, AND WHY ────────────────
--
--   crm_saved_views          Has `owner_user_id` and `is_shared`, no lead.
--                            Scoped to own rows, plus read on shared ones.
--   crm_suggestion_dismissals A dedupe suggestion is about a PAIR of leads,
--                            so visibility needs BOTH — a rep who owns one
--                            side has no business seeing the other.
--   crm_email_templates      A genuinely shared library, and the app only
--                            ever READS it (listTemplates and one read by
--                            id in composeEmail.ts — no insert, update or
--                            delete anywhere). So: read for admin and sales,
--                            write for admin only. Narrowing writes to a
--                            table nothing writes costs nothing and stops
--                            one rep editing the copy every rep sends.
--
-- `crm_locality_geocode_cache` is left exactly as it is: a shared cache of
-- locality name → approximate lat/lng, no lead, no personal information, and
-- lib/crm/localityGeocode.ts both reads and upserts it from any CRM session.
-- Scoping it would break bulk import to protect nothing.
--
-- `crm_signatures` (0072) and `crm_audit_log`/`crm_sendas_aliases` (0072/0074)
-- are already self- or admin-scoped and are not touched.

-- ── 1. The one visibility predicate ────────────────────────────────────

CREATE OR REPLACE FUNCTION crm_can_see_lead(p_lead_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    -- A NULL lead_id is not a visibility question; callers that allow it
    -- (crm_tasks) handle it themselves. Answering false here keeps this
    -- function's contract single-valued.
    WHEN p_lead_id IS NULL THEN false
    WHEN (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' THEN true
    WHEN (SELECT role FROM profiles WHERE id = auth.uid()) = 'sales' THEN
      EXISTS (
        SELECT 1 FROM crm_leads
         WHERE id = p_lead_id
           AND owner_user_id = auth.uid()
      )
    ELSE false
  END;
$$;

COMMENT ON FUNCTION crm_can_see_lead(UUID) IS
  'The single definition of CRM lead visibility: admin sees all, sales sees '
  'leads it owns, everyone else sees none. Every crm_* child-table policy is '
  'written through this so the rule lives in one place (audit A-09). '
  'SECURITY DEFINER because a sales caller cannot SELECT another rep''s '
  'crm_leads row by design; returns a boolean and never a row.';

-- Reachable from a policy expression, which runs as the querying role.
-- Named explicitly here AND in 0125's allow-list, which is the contract that
-- migration set up.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION crm_can_see_lead(UUID) TO anon, authenticated;
  END IF;
END $$;

-- ── 2. crm_activities ──────────────────────────────────────────────────

DROP POLICY IF EXISTS "crm_activities_admin_sales_select" ON crm_activities;
DROP POLICY IF EXISTS "crm_activities_admin_sales_insert" ON crm_activities;
DROP POLICY IF EXISTS "crm_activities_admin_sales_update" ON crm_activities;
DROP POLICY IF EXISTS "crm_activities_admin_sales_delete" ON crm_activities;

CREATE POLICY "crm_activities_lead_scoped_select" ON crm_activities
  FOR SELECT USING (crm_can_see_lead(lead_id));
CREATE POLICY "crm_activities_lead_scoped_insert" ON crm_activities
  FOR INSERT WITH CHECK (crm_can_see_lead(lead_id));
CREATE POLICY "crm_activities_lead_scoped_update" ON crm_activities
  FOR UPDATE USING (crm_can_see_lead(lead_id))
             WITH CHECK (crm_can_see_lead(lead_id));
CREATE POLICY "crm_activities_lead_scoped_delete" ON crm_activities
  FOR DELETE USING (crm_can_see_lead(lead_id));

-- ── 3. crm_lead_contacts ───────────────────────────────────────────────

DROP POLICY IF EXISTS "crm_lead_contacts_admin_sales_select" ON crm_lead_contacts;
DROP POLICY IF EXISTS "crm_lead_contacts_admin_sales_insert" ON crm_lead_contacts;
DROP POLICY IF EXISTS "crm_lead_contacts_admin_sales_update" ON crm_lead_contacts;
DROP POLICY IF EXISTS "crm_lead_contacts_admin_sales_delete" ON crm_lead_contacts;

CREATE POLICY "crm_lead_contacts_lead_scoped_select" ON crm_lead_contacts
  FOR SELECT USING (crm_can_see_lead(lead_id));
CREATE POLICY "crm_lead_contacts_lead_scoped_insert" ON crm_lead_contacts
  FOR INSERT WITH CHECK (crm_can_see_lead(lead_id));
CREATE POLICY "crm_lead_contacts_lead_scoped_update" ON crm_lead_contacts
  FOR UPDATE USING (crm_can_see_lead(lead_id))
             WITH CHECK (crm_can_see_lead(lead_id));
CREATE POLICY "crm_lead_contacts_lead_scoped_delete" ON crm_lead_contacts
  FOR DELETE USING (crm_can_see_lead(lead_id));

-- ── 4. crm_lead_tags ───────────────────────────────────────────────────

DROP POLICY IF EXISTS "crm_lead_tags_admin_sales_select" ON crm_lead_tags;
DROP POLICY IF EXISTS "crm_lead_tags_admin_sales_insert" ON crm_lead_tags;
DROP POLICY IF EXISTS "crm_lead_tags_admin_sales_delete" ON crm_lead_tags;

CREATE POLICY "crm_lead_tags_lead_scoped_select" ON crm_lead_tags
  FOR SELECT USING (crm_can_see_lead(lead_id));
CREATE POLICY "crm_lead_tags_lead_scoped_insert" ON crm_lead_tags
  FOR INSERT WITH CHECK (crm_can_see_lead(lead_id));
CREATE POLICY "crm_lead_tags_lead_scoped_delete" ON crm_lead_tags
  FOR DELETE USING (crm_can_see_lead(lead_id));

-- ── 5. crm_tasks ───────────────────────────────────────────────────────
--
-- lead_id is NULLABLE here on purpose — 0107's comment: "a task not attached
-- to a lead must be legal (e.g. 'call the printer about signage')". So the
-- predicate is ownership of the TASK, or visibility of its lead when it has
-- one. Without the first clause every rep's own admin tasks would vanish.

DROP POLICY IF EXISTS "crm_tasks_admin_sales_select" ON crm_tasks;
DROP POLICY IF EXISTS "crm_tasks_admin_sales_insert" ON crm_tasks;
DROP POLICY IF EXISTS "crm_tasks_admin_sales_update" ON crm_tasks;
DROP POLICY IF EXISTS "crm_tasks_admin_sales_delete" ON crm_tasks;

CREATE POLICY "crm_tasks_scoped_select" ON crm_tasks
  FOR SELECT USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR owner_user_id = auth.uid()
    OR crm_can_see_lead(lead_id)
  );
CREATE POLICY "crm_tasks_scoped_insert" ON crm_tasks
  FOR INSERT WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR (
      (SELECT role FROM profiles WHERE id = auth.uid()) = 'sales'
      -- A rep may only create tasks OWNED BY THEMSELVES, and only against a
      -- lead they can see (or no lead at all).
      AND owner_user_id = auth.uid()
      AND (lead_id IS NULL OR crm_can_see_lead(lead_id))
    )
  );
CREATE POLICY "crm_tasks_scoped_update" ON crm_tasks
  FOR UPDATE USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR owner_user_id = auth.uid()
    OR crm_can_see_lead(lead_id)
  ) WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR (
      (SELECT role FROM profiles WHERE id = auth.uid()) = 'sales'
      AND owner_user_id = auth.uid()
      AND (lead_id IS NULL OR crm_can_see_lead(lead_id))
    )
  );
CREATE POLICY "crm_tasks_scoped_delete" ON crm_tasks
  FOR DELETE USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR owner_user_id = auth.uid()
  );

-- ── 6. crm_saved_views — own rows, plus read on shared ones ────────────

DROP POLICY IF EXISTS "crm_saved_views_admin_sales_select" ON crm_saved_views;
DROP POLICY IF EXISTS "crm_saved_views_admin_sales_insert" ON crm_saved_views;
DROP POLICY IF EXISTS "crm_saved_views_admin_sales_update" ON crm_saved_views;
DROP POLICY IF EXISTS "crm_saved_views_admin_sales_delete" ON crm_saved_views;

CREATE POLICY "crm_saved_views_self_select" ON crm_saved_views
  FOR SELECT USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR owner_user_id = auth.uid()
    OR (is_shared AND (SELECT role FROM profiles WHERE id = auth.uid()) = 'sales')
  );
CREATE POLICY "crm_saved_views_self_insert" ON crm_saved_views
  FOR INSERT WITH CHECK (
    owner_user_id = auth.uid()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );
CREATE POLICY "crm_saved_views_self_update" ON crm_saved_views
  FOR UPDATE USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR owner_user_id = auth.uid()
  ) WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR owner_user_id = auth.uid()
  );
CREATE POLICY "crm_saved_views_self_delete" ON crm_saved_views
  FOR DELETE USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR owner_user_id = auth.uid()
  );

-- ── 7. crm_suggestion_dismissals — BOTH sides of the pair ──────────────

DROP POLICY IF EXISTS "crm_suggestion_dismissals_admin_sales_select" ON crm_suggestion_dismissals;
DROP POLICY IF EXISTS "crm_suggestion_dismissals_admin_sales_insert" ON crm_suggestion_dismissals;
DROP POLICY IF EXISTS "crm_suggestion_dismissals_admin_sales_delete" ON crm_suggestion_dismissals;

CREATE POLICY "crm_suggestion_dismissals_pair_scoped_select" ON crm_suggestion_dismissals
  FOR SELECT USING (crm_can_see_lead(lead_a_id) AND crm_can_see_lead(lead_b_id));
CREATE POLICY "crm_suggestion_dismissals_pair_scoped_insert" ON crm_suggestion_dismissals
  FOR INSERT WITH CHECK (crm_can_see_lead(lead_a_id) AND crm_can_see_lead(lead_b_id));
CREATE POLICY "crm_suggestion_dismissals_pair_scoped_delete" ON crm_suggestion_dismissals
  FOR DELETE USING (crm_can_see_lead(lead_a_id) AND crm_can_see_lead(lead_b_id));

-- ── 8. crm_email_templates — shared read, admin write ──────────────────

DROP POLICY IF EXISTS "crm_email_templates_admin_sales_select" ON crm_email_templates;
DROP POLICY IF EXISTS "crm_email_templates_admin_sales_insert" ON crm_email_templates;
DROP POLICY IF EXISTS "crm_email_templates_admin_sales_update" ON crm_email_templates;
DROP POLICY IF EXISTS "crm_email_templates_admin_sales_delete" ON crm_email_templates;

CREATE POLICY "crm_email_templates_shared_select" ON crm_email_templates
  FOR SELECT USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );
CREATE POLICY "crm_email_templates_admin_insert" ON crm_email_templates
  FOR INSERT WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  );
CREATE POLICY "crm_email_templates_admin_update" ON crm_email_templates
  FOR UPDATE USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  ) WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  );
CREATE POLICY "crm_email_templates_admin_delete" ON crm_email_templates
  FOR DELETE USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  );

-- ── 9. A-10 — crm_leads UPDATE gets its predicate back in WITH CHECK ───
--
-- 0113's version:
--     WITH CHECK ( role = 'admin' OR role = 'sales' )      ← ownership gone
-- Reassignment becomes an admin action. A rep who genuinely needs to hand a
-- lead over asks, and the ask is visible.

DROP POLICY IF EXISTS "crm_leads_admin_sales_update" ON crm_leads;

CREATE POLICY "crm_leads_admin_sales_update" ON crm_leads
  FOR UPDATE USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR (
      (SELECT role FROM profiles WHERE id = auth.uid()) = 'sales'
      AND owner_user_id = auth.uid()
    )
  ) WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR (
      (SELECT role FROM profiles WHERE id = auth.uid()) = 'sales'
      AND owner_user_id = auth.uid()
    )
  );

COMMENT ON TABLE crm_lead_contacts IS
  'Practitioner contact rows for a lead: names, direct emails, cellphones, '
  'HPCSA numbers. Visibility is the LEAD''s, via crm_can_see_lead (0129) — '
  'before that a sales user could read every rep''s contacts in one request '
  '(audit A-09).';
