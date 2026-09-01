-- ─── applications stops being patient-writable ──────────────────────────
--
-- THE DEFECT (audit 2026-09-02, A-17)
--
-- 0002 shipped this:
--
--     CREATE POLICY "patients_insert_own_applications" ON applications
--       FOR INSERT WITH CHECK (patient_id = auth.uid());
--
-- The only predicate is that the row names the caller. `practice_id`,
-- `bill_amount` and `status` are unconstrained, there is no check that the
-- patient has any relationship to the practice, no trading-gate check (which
-- 0043 correctly added to the practice-side INSERT policy), and no trigger on
-- this table at all. So:
--
--     POST /rest/v1/applications
--     { "patient_id": "<self>", "practice_id": "<any practice>",
--       "bill_amount": 99999, "status": "pending" }
--
-- No money moves — `plans` INSERT needs is_practice_biller plus the trading
-- gate, so no plan and no payment schedule follows. What lands is a
-- fabricated bill record in that practice's applications list
-- (`practice_members_select_applications`) and in the patient's own orders
-- view, which renders declined applications. A patient can also delete their
-- own application history, or insert in bulk.
--
-- Not a financial hole. A dispute-integrity one: "your system shows I was
-- billed R99,999 by this practice" is a support conversation nobody wants,
-- and it means `applications` cannot be treated as evidence of anything.
--
-- 0006's `practice_members_delete_applications` has the matching gap in the
-- other direction — unbounded by lifecycle stage, where the equivalent plan
-- deletion is limited to `pending_acceptance` by `protect_plans_write`.
--
-- ─── THE FIX, on the 0121 pattern ──────────────────────────────────────
--
--   1. Drop the patient INSERT policy. Nothing legitimate uses it. Both
--      creators — createBill (app/practice/bills/new/actions.ts) and
--      issueCounterSession (app/practice/pos/actions.ts) — insert on the
--      practice member's own session client or the service-role client. A
--      patient has never needed to insert one, and 0011's equivalent policy
--      on `payments` was dropped by 0121 for the same reason.
--
--   2. Add the trigger the table never had, so the surviving practice-side
--      INSERT and DELETE policies cannot be used for anything but raising a
--      bill and rolling that back. Same bypass posture as 0121/0122/0054:
--      service_role, or an opted-in SECURITY DEFINER RPC.
--
-- WHY A TRIGGER AND NOT A NARROWER POLICY: RLS cannot express a column
-- restriction and WITH CHECK cannot compare old to new. That is the whole
-- reason 0054, 0121 and 0122 exist, and this is the last table on the
-- billing path without one.

-- ── 1. Drop the patient INSERT policy ──────────────────────────────────

DROP POLICY IF EXISTS "patients_insert_own_applications" ON applications;

-- ── 2. Column/row lock ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION protect_applications_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- IS TRUE, not a bare test: see 0126 on why this predicate could
  -- return NULL before that migration repaired it.
  IF hnpl_write_is_privileged() IS TRUE THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A bill is raised, and nothing else. An application inserted already
    -- approved or declined would be a decision the platform never made.
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION
        'an application raised from a user session must start at pending (got %)', NEW.status;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Nothing on this row is user-editable. plan_type is stamped at
    -- acceptance by a server action on the privileged client
    -- (app/patient/actions.ts), and bill_amount is money.
    RAISE EXCEPTION
      'applications rows are not writable from a user session — every '
      'transition goes through a server action on the privileged client '
      '(audit A-17)';
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- The practice DELETE policy exists for createBill's and
    -- issueCounterSession's own rollback, which only ever unwind an
    -- application they just inserted. Anything with a plan past acceptance
    -- behind it is a customer's live agreement.
    IF OLD.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION
        'only an application still at pending may be deleted from a user session (got %)', OLD.status;
    END IF;
    IF EXISTS (
      SELECT 1 FROM plans
       WHERE plans.application_id = OLD.id
         AND plans.status IS DISTINCT FROM 'pending_acceptance'
    ) THEN
      RAISE EXCEPTION
        'this application has a plan past acceptance — it cannot be deleted from a user session';
    END IF;
    RETURN OLD;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_applications_write ON applications;
CREATE TRIGGER trg_protect_applications_write
  BEFORE INSERT OR UPDATE OR DELETE ON applications
  FOR EACH ROW
  EXECUTE FUNCTION protect_applications_write();

COMMENT ON FUNCTION protect_applications_write() IS
  'Column/row lock for applications, on the 0121 pattern. Non-privileged '
  'UPDATE is refused outright; INSERT is pinned to status=''pending''; DELETE '
  'is limited to a still-pending application whose plan has not passed '
  'acceptance (createBill / issueCounterSession rollback). Bypassed by '
  'hnpl_write_is_privileged(). See audit A-17.';
