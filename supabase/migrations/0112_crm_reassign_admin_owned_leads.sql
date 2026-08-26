-- ─── CRM Phase 2.2 — reassign admin-owned leads to sales (data step) ──
--
-- SEQUENCING IS LOAD-BEARING. This migration MUST run and complete
-- before 0113 tightens crm_leads RLS to owner-scoped. Tightening RLS
-- first would lock the only salesperson out of ~90% of the book the
-- moment it applied. Applying the reassignment first means Steve owns
-- every lead he's about to be scoped to before that scoping exists.
--
-- Reassigns every crm_leads row currently owned by an admin-role
-- profile to the (sole, as of this writing) sales-role profile. Leads
-- with a NULL owner are left untouched — the spec calls out the
-- 259 admin-owned leads specifically, not the unclaimed-inbound rows,
-- and admin retains full read/write over every row regardless of
-- owner once 0113 lands, so nothing becomes unreachable.

DO $$
DECLARE
  v_sales_count INT;
  v_steve       UUID;
  v_reassigned  INT;
BEGIN
  SELECT count(*) INTO v_sales_count FROM profiles WHERE role = 'sales';
  IF v_sales_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one sales-role profile to reassign admin-owned leads to, found %', v_sales_count;
  END IF;

  SELECT id INTO v_steve FROM profiles WHERE role = 'sales';

  UPDATE crm_leads
     SET owner_user_id = v_steve
   WHERE owner_user_id IN (SELECT id FROM profiles WHERE role = 'admin');
  GET DIAGNOSTICS v_reassigned = ROW_COUNT;

  RAISE NOTICE 'crm_leads reassignment: % admin-owned lead(s) reassigned to sales profile %', v_reassigned, v_steve;
END $$;
