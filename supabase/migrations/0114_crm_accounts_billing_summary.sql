-- ─── CRM Phase 2.3 — Accounts view read path ──────────────────────────
--
-- The Accounts view needs actual billings (payments), joined through
-- plans, joined through practices, for leads a CRM user can see. But
-- practices/plans/payments RLS is scoped to platform admins and
-- practice members — a `sales` CRM user is neither, so a direct SELECT
-- from the client would silently return nothing for them even though
-- they own the crm_leads row.
--
-- This is a narrowly-scoped, read-only RPC: SECURITY DEFINER (so it
-- can see across the join regardless of the caller's own RLS grants),
-- but it re-implements the ownership check itself inside the query —
-- REQUIRED because SECURITY DEFINER bypasses RLS on every table it
-- touches, crm_leads included, so skipping this check would leak every
-- lead + practice to any authenticated caller. No INSERT/UPDATE/DELETE
-- anywhere in this function — reads only, exactly what the caller
-- could already reach via crm_leads.owner_user_id, joined into tables
-- they otherwise can't SELECT directly.

CREATE OR REPLACE FUNCTION crm_accounts_billing_summary()
RETURNS TABLE (
  lead_id               UUID,
  practice_id           UUID,
  practice_name         TEXT,
  plan_id               UUID,
  payment_amount        NUMERIC,
  payment_status        TEXT,
  payment_collected_at  TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    l.id, pr.id, pr.name, p.id, pay.amount, pay.status, pay.collected_at
  FROM crm_leads l
  JOIN practices pr ON pr.id = l.converted_practice_id
  LEFT JOIN plans p ON p.practice_id = pr.id
  LEFT JOIN payments pay ON pay.plan_id = p.id
  WHERE l.converted_practice_id IS NOT NULL
    AND l.archived_at IS NULL
    AND (
      (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
      OR (
        (SELECT role FROM profiles WHERE id = auth.uid()) = 'sales'
        AND l.owner_user_id = auth.uid()
      )
    );
$$;

GRANT EXECUTE ON FUNCTION crm_accounts_billing_summary() TO authenticated;

COMMENT ON FUNCTION crm_accounts_billing_summary() IS
  'Read-only join across crm_leads -> practices -> plans -> payments for the '
  'CRM Accounts view. SECURITY DEFINER so it can read practices/plans/payments '
  'a sales-role caller cannot SELECT directly, but re-checks admin-sees-all / '
  'sales-sees-own-leads itself since SECURITY DEFINER bypasses RLS entirely.';
