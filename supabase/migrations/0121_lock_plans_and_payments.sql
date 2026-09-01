-- ─── Close the patient write primitive over plans and payments ──────────
--
-- THE DEFECT (audit 2026-09-01, F-01 / F-02 / F-03)
--
-- Migration 0007 gave patients this pair:
--
--     CREATE POLICY "patients_update_own_plans" ON plans
--       FOR UPDATE USING (patient_id = auth.uid())
--                  WITH CHECK (patient_id = auth.uid());
--
-- and the same shape on payments, plus 0011's INSERT policy. Those
-- restrict WHICH ROW the patient may write and say nothing about WHICH
-- COLUMNS — Postgres RLS cannot express a column restriction inside a
-- policy, and WITH CHECK cannot compare old to new. That is precisely the
-- gap migration 0054 was written to close for `profiles` and `practices`.
-- It was never applied here, and there has never been a trigger on either
-- table.
--
-- WHY THAT IS NOT AN APPLICATION-LAYER PROBLEM
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY is in the browser bundle by construction
-- (lib/supabase/client.ts) and @supabase/ssr writes the auth cookie with
-- httpOnly:false, so a patient holds both halves of a PostgREST
-- credential. They never have to call a Server Action at all:
--
--     PATCH /rest/v1/plans?id=eq.<own plan>     {"status":"completed"}
--     PATCH /rest/v1/payments?patient_id=eq.<self>  {"status":"collected"}
--     PATCH /rest/v1/payments?id=eq.<instalment 1>  {"amount":1.00}
--
-- The third one is the expensive one. initializeFirstPayment reads the
-- charge amount straight off the row it is about to charge
-- (app/patient/actions.ts), so R1.00 is charged — and then
-- activateFirstInstalment inserts a payout for 94% of the UNTOUCHED
-- plans.total_amount. The two numbers were never compared anywhere.
--
-- THE FIX, in three parts
--
--   1. Drop the three policies. A patient has no legitimate direct write
--      to either table: every real transition (acceptPlan, payWithSavedCard,
--      declinePlan, initializeFirstPayment) is a Server Action, and those
--      actions move to the service-role client in the same commit as this
--      migration. Nothing legitimate is left needing a session-client write.
--
--   2. Add BEFORE UPDATE / INSERT / DELETE triggers as defence in depth,
--      on the 0054 pattern. With the policies gone the triggers are
--      unreachable from a patient session today; they exist so that
--      re-adding a policy later — the exact mistake 0007 made — cannot
--      silently re-open this. They also close the provider-side writes
--      that the practice INSERT/DELETE policies still permit.
--
--   3. Add the UNIQUE index on (plan_id, instalment_number) that the table
--      has never had. Its absence is what turns acceptPlan's and
--      payWithSavedCard's check-then-write races into DUPLICATED SCHEDULES
--      instead of constraint violations. The actions also gain a status
--      precondition in the same commit; this index is the layer that holds
--      when the application layer is wrong.
--
-- BYPASS POSTURE — identical to 0054, deliberately. `service_role` (the
-- privileged clients in the Server Actions, the webhooks and the crons) or
-- an opted-in SECURITY DEFINER RPC via
-- set_config('app.privileged_write','on',true). Platform admins are NOT
-- exempt: no admin surface writes these tables from a session client today
-- (retryCollection already routes through service-role), and an admin
-- session cookie is a high-value target that should not carry a silent
-- write primitive over the ledger.

-- ── 1. Drop the column-unrestricted patient policies ───────────────────

DROP POLICY IF EXISTS "patients_update_own_plans"              ON plans;
DROP POLICY IF EXISTS "patients_update_own_payments"           ON payments;
DROP POLICY IF EXISTS "patients_insert_payments_for_own_plans" ON payments;

-- 0006/0043's practice-side payments INSERT policy goes too. Nothing has
-- ever used it — payment rows are created at ACCEPTANCE (by the patient's
-- action, now service-role) or by the till's own service-role client, never
-- by a practice member's session. Leaving an unused write policy on the
-- ledger open is the same class of latent hole as the two above.
DROP POLICY IF EXISTS "practice_members_insert_payments"       ON payments;

-- ── 2. Triggers ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hnpl_write_is_privileged()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT auth.role() = 'service_role'
      OR current_setting('app.privileged_write', true) = 'on';
$$;

COMMENT ON FUNCTION hnpl_write_is_privileged() IS
  'The 0054 bypass predicate, extracted so every column-lock trigger '
  'shares one definition. True for the service-role clients and for a '
  'SECURITY DEFINER RPC that opted in via '
  'set_config(''app.privileged_write'', ''on'', true).';

-- plans ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION protect_plans_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF hnpl_write_is_privileged() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- No column on plans is user-editable. status, total_amount,
    -- instalment_amount, plan_type, patient_id, the Peach chain-root ids
    -- and the terms/privacy audit columns are all either money, ledger
    -- state, or a legal record.
    RAISE EXCEPTION
      'plans rows are not writable from a user session — every transition '
      'goes through a server action on the privileged client (audit F-01)';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- createBill / issueCounterSession raise a bill and nothing else. A
    -- practice inserting a plan already ACTIVE (or already carrying an
    -- acceptance stamp) would be manufacturing a debt the patient never
    -- agreed to.
    IF NEW.status IS DISTINCT FROM 'pending_acceptance' THEN
      RAISE EXCEPTION
        'a plan raised from a user session must start at pending_acceptance (got %)', NEW.status;
    END IF;
    IF NEW.terms_accepted_at IS NOT NULL
       OR NEW.completed_at   IS NOT NULL
       OR NEW.plan_type      IS NOT NULL
       OR NEW.instalment_amount IS NOT NULL THEN
      RAISE EXCEPTION
        'acceptance-time columns (terms_accepted_at / completed_at / plan_type / '
        'instalment_amount) cannot be pre-set when a bill is raised';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- The practice DELETE policy exists for createBill's own rollback,
    -- which only ever unwinds a plan it just inserted. Anything past
    -- acceptance is a customer's live agreement.
    IF OLD.status IS DISTINCT FROM 'pending_acceptance' THEN
      RAISE EXCEPTION
        'only a plan still at pending_acceptance may be deleted from a user session (got %)', OLD.status;
    END IF;
    RETURN OLD;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_plans_write ON plans;
CREATE TRIGGER trg_protect_plans_write
  BEFORE INSERT OR UPDATE OR DELETE ON plans
  FOR EACH ROW
  EXECUTE FUNCTION protect_plans_write();

COMMENT ON FUNCTION protect_plans_write() IS
  'Column/row lock for plans. Non-privileged UPDATE is refused outright; '
  'INSERT is pinned to pending_acceptance with no acceptance columns '
  'pre-set; DELETE is limited to a still-pending plan (createBill''s '
  'rollback). Bypassed by hnpl_write_is_privileged(). See audit F-01.';

-- payments ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION protect_payments_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF hnpl_write_is_privileged() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- payments IS the ledger. There is no user-session write to it at all —
  -- not status, not amount, not the Peach reference. The schedule is
  -- written at acceptance and mutated only by the charge paths, all of
  -- which hold the privileged client.
  RAISE EXCEPTION
    'payments rows are not writable from a user session — the schedule and '
    'its statuses are server-side state (audit F-02)';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_payments_write ON payments;
CREATE TRIGGER trg_protect_payments_write
  BEFORE INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW
  EXECUTE FUNCTION protect_payments_write();

COMMENT ON FUNCTION protect_payments_write() IS
  'Refuses every non-privileged write to payments. Bypassed by '
  'hnpl_write_is_privileged(). See audit F-02.';

-- ── 3. One instalment number per plan ──────────────────────────────────
--
-- Partial on kind='instalment' because settlement rows (0058) share the
-- table and carry instalment_number NULL / duplicated by construction.
--
-- If this migration fails here, the table already holds a duplicated
-- schedule — which is the F-03 race having actually fired in production.
-- Do NOT drop the index to get the migration through: reconcile the rows
-- first (the later created_at of each pair is the duplicate; check whether
-- either was charged before deleting), then re-run.

DO $$
DECLARE
  dup_count int;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT plan_id, instalment_number
      FROM payments
     WHERE kind = 'instalment'
     GROUP BY plan_id, instalment_number
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'cannot add payments_plan_instalment_uniq: % (plan_id, instalment_number) pairs are already duplicated. '
      'This is the F-03 race having fired. Reconcile those rows before re-running this migration.', dup_count;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payments_plan_instalment_uniq
  ON payments (plan_id, instalment_number)
  WHERE kind = 'instalment';

COMMENT ON INDEX payments_plan_instalment_uniq IS
  'One row per instalment per plan. The constraint the table never had — '
  'without it, two concurrent acceptPlan / payWithSavedCard calls that both '
  'pass the pending_acceptance SELECT each insert a full schedule. The '
  'actions also carry a status precondition now; this is the layer that '
  'holds when they are wrong. See audit F-03.';
