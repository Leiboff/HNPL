-- ─── CRM Phase 2.2 — owner-scoped RLS on crm_leads ────────────────────
--
-- Runs AFTER 0112's reassignment (see that file's header — the order
-- is load-bearing). Sales now reads/writes only leads they own; admin
-- keeps full read/write over every row. Predicate shape unchanged
-- (the same `(SELECT role FROM profiles WHERE id = auth.uid())`
-- subquery this codebase always uses) — just narrowed for the sales
-- branch.
--
-- Scope: crm_leads only, per the task. crm_activities/crm_lead_contacts/
-- crm_tasks are NOT scoped here — the spec's adversarial tests (and
-- its own wording, "sales reads and writes rows they own") are all
-- about crm_leads directly; scoping the child tables too is a larger,
-- separately-reasoned change this migration deliberately leaves alone.
--
-- DELETE is untouched — already admin-only since 0109.

DROP POLICY IF EXISTS "crm_leads_admin_sales_select" ON crm_leads;
CREATE POLICY "crm_leads_admin_sales_select"
  ON crm_leads FOR SELECT
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR (
      (SELECT role FROM profiles WHERE id = auth.uid()) = 'sales'
      AND owner_user_id = auth.uid()
    )
  );

-- INSERT: admin may insert anything; sales may only insert a row that
-- is unowned or owned by themselves (they cannot plant a lead directly
-- into someone else's pipeline).
DROP POLICY IF EXISTS "crm_leads_admin_sales_insert" ON crm_leads;
CREATE POLICY "crm_leads_admin_sales_insert"
  ON crm_leads FOR INSERT
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR (
      (SELECT role FROM profiles WHERE id = auth.uid()) = 'sales'
      AND (owner_user_id = auth.uid() OR owner_user_id IS NULL)
    )
  );

-- UPDATE: sales may only touch a row they CURRENTLY own (USING) — this
-- is what makes "bulk assign to" a genuine hand-off rather than a
-- one-way ratchet: WITH CHECK does not re-require the new owner to
-- still be them, so a sales rep can reassign their own lead to a
-- teammate without being locked out of the write itself.
DROP POLICY IF EXISTS "crm_leads_admin_sales_update" ON crm_leads;
CREATE POLICY "crm_leads_admin_sales_update"
  ON crm_leads FOR UPDATE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR (
      (SELECT role FROM profiles WHERE id = auth.uid()) = 'sales'
      AND owner_user_id = auth.uid()
    )
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR (SELECT role FROM profiles WHERE id = auth.uid()) = 'sales'
  );
