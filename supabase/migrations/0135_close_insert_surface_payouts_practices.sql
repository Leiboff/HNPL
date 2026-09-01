-- ─── The two tables where INSERT was still the whole attack ─────────────
--
-- THE DEFECTS (audit round three, R3-01 and R3-02)
--
-- Rounds one and two closed the UPDATE surface on every money table.
-- `protect_plans_write`, `protect_payments_write` and
-- `protect_applications_write` each handle INSERT, UPDATE and DELETE.
-- `protect_profiles_columns` is UPDATE-only, and that is correct — 0030
-- dropped the profiles INSERT policy, so there is no INSERT to guard.
--
-- Two tables were left with a permissive INSERT policy and no trigger:
--
--   payouts    0009's `patients_insert_payout_on_accept` grants a patient
--              INSERT, with a WITH CHECK that constrains plan_id AND
--              NOTHING ELSE. payouts.plan_id is UNIQUE (0087) and the only
--              legitimate creator upserts ON CONFLICT DO NOTHING
--              (lib/payments/activateFirstInstalment.ts:207). So the
--              patient who inserts FIRST wins and the real write silently
--              no-ops — the idempotency that makes concurrent activation
--              safe is what makes the forgery stick.
--
--              That hands the patient net_amount, practice_id, status,
--              payout_destination, provider_id, batch_id, created_at and
--              all five snapshot_* banking columns on a real payout for a
--              real bill. net_amount=0.01 defrauds the practice;
--              practice_id pointed at an attacker-owned practice redirects
--              the settlement; status='paid' means the weekly runner's
--              `.eq('status','pending')` never sees it and the practice is
--              never paid at all.
--
--   practices  0002's `authenticated_insert_practice` grants any
--              authenticated user INSERT with owner_id = self.
--              `protect_practices_columns` (0054) pins status,
--              fee_percent, approved_at and approved_by — but it was
--              created BEFORE UPDATE, so at INSERT time status='approved'
--              and fee_percent=0 are simply accepted. Adding an own
--              practice_members row with role='provider' (0003's
--              `owners_insert_own_membership`) then satisfies
--              practice_can_trade(), and the result is an approved,
--              zero-fee, trading merchant that no admin ever saw.
--
--              practices.group_id is NOT NULL and practice_groups has no
--              non-admin INSERT policy, which looks like it should block
--              this. It does not: `patients_select_practice_for_own_plans`
--              lets any billed patient read the full practices row of the
--              practice that billed them, group_id included.
--
-- Both are proved in security-audit-r3-payouts-practices.rls.test.ts, and
-- the fixed behaviour is proved in 0135_close_insert_surface.rls.test.ts.
--
-- ─── WHY THE POLICIES ARE DROPPED RATHER THAN NARROWED ─────────────────
--
-- Both are dead code. Every write in the tree was checked:
--
--   payouts   INSERT/UPSERT: activateFirstInstalment.ts:207 only, on the
--             service-role client.
--   practices INSERT: signup/practice/actions.ts:282 and
--             brand/actions.ts:142, both on svc().
--
-- A narrowed policy would be a second thing to keep correct. There is
-- nothing left for either policy to permit.
--
-- ─── THE ONE PATH THAT MUST KEEP WORKING, AND WHY IT SHAPES THE TRIGGER ─
--
-- `payouts` cannot take the blanket refusal `protect_plans_write` uses,
-- because the admin settlement path is NOT on the service-role client:
--
--   app/admin/payouts/actions.ts:25   const supabase = await createClient()
--   app/admin/payouts/actions.ts:79   markBatchPaid  → payouts.update({status,paid_at})
--   app/admin/payouts/actions.ts:131  markPayoutPaid → payouts.update({status,paid_at})
--
-- Those run as `authenticated` through the `admins_all_payouts` policy, and
-- that is deliberate rather than an oversight: 0131's
-- `trg_log_payout_settlement` records `auth.uid()` as the actor, and moving
-- the path to service_role would make every settlement audit row read
-- actor_id = NULL. The audit trail depends on the session client.
--
-- So the UPDATE branch below allows exactly that write and nothing else: a
-- platform admin, changing only status and paid_at, pending → paid. Any
-- other column, any other transition, any other caller is refused. The
-- column comparison is the `to_jsonb(NEW) <> to_jsonb(OLD)` key-diff shape
-- 0122 uses, so a column added to payouts tomorrow is locked by default
-- rather than accidentally writable.

-- ── 1. payouts (R3-01) ─────────────────────────────────────────────────

DROP POLICY IF EXISTS "patients_insert_payout_on_accept" ON payouts;

CREATE OR REPLACE FUNCTION protect_payouts_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed text;
BEGIN
  -- IS TRUE, not a bare test: 0126's header explains why this predicate
  -- could return NULL before it was repaired, and why every guard added
  -- since is written so that it stays correct if that ever regresses.
  IF hnpl_write_is_privileged() IS TRUE THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION
      'payouts rows are created only by activateFirstInstalment, on the '
      'privileged client. A payout written from a user session is a '
      'forged settlement instruction (audit R3-01)';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'payouts rows are never deleted from a user session — a settlement '
      'that did not happen is a status, not an absence (audit R3-01)';
  END IF;

  -- ── UPDATE: the admin settlement flip, and nothing else ──────────────
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION
      'only a platform admin may update a payout, and only to settle it '
      '(audit R3-01)';
  END IF;

  SELECT string_agg(n.key, ', ' ORDER BY n.key)
    INTO changed
    FROM jsonb_each(to_jsonb(NEW)) AS n
   WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);

  IF changed IS DISTINCT FROM 'paid_at, status' THEN
    RAISE EXCEPTION
      'a payout settlement may change only status and paid_at (changed: %). '
      'Amounts, destination and the banking snapshot are written once, by '
      'activateFirstInstalment (audit R3-01)', COALESCE(changed, '<nothing>');
  END IF;

  IF OLD.status IS DISTINCT FROM 'pending' OR NEW.status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION
      'the only settlement transition is pending → paid (got % → %)',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION protect_payouts_write() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_protect_payouts_write ON payouts;
CREATE TRIGGER trg_protect_payouts_write
  BEFORE INSERT OR UPDATE OR DELETE ON payouts
  FOR EACH ROW
  EXECUTE FUNCTION protect_payouts_write();

COMMENT ON FUNCTION protect_payouts_write() IS
  'Write lock for payouts, on the 0121 pattern. A user session may not '
  'INSERT or DELETE at all; UPDATE is limited to a platform admin flipping '
  'status pending→paid together with paid_at, which is what '
  'app/admin/payouts/actions.ts does on the SESSION client so that 0131''s '
  'settlement audit row carries a real actor_id. Bypassed by '
  'hnpl_write_is_privileged(). See audit R3-01.';

-- ── 2. practices (R3-02) ───────────────────────────────────────────────
--
-- The UPDATE branch is preserved verbatim from 0054. Only the INSERT
-- branch and the trigger's event list are new.
--
-- fee_percent: PostgreSQL applies a column DEFAULT before a BEFORE ROW
-- trigger fires, so an INSERT that omits the column arrives here already
-- carrying 6.00 and passes. An INSERT that names a different value is
-- refused rather than silently rewritten — a merchant proposing its own
-- platform margin is worth an error, not a correction. The literal must
-- track the column default on practices.fee_percent; there is a test that
-- pins the two together.

CREATE OR REPLACE FUNCTION protect_practices_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_default_fee CONSTANT numeric := 6.00;
BEGIN
  IF auth.role() = 'service_role'
     OR current_setting('app.privileged_write', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION
        'a practice created from a user session starts at pending — '
        'approval is an admin action (audit R3-02), got %', NEW.status;
    END IF;
    IF NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION
        'approved_at / approved_by are stamped by approvePractice, never '
        'supplied at creation (audit R3-02)';
    END IF;
    IF NEW.fee_percent IS DISTINCT FROM c_default_fee THEN
      RAISE EXCEPTION
        'practices.fee_percent is the platform margin and is set only by '
        'changePracticeFeePercent (audit R3-02), got %', NEW.fee_percent;
    END IF;
    RETURN NEW;
  END IF;

  -- ── UPDATE — unchanged from 0054 ────────────────────────────────────
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'practices.status is set only by an admin action (approvePractice / suspendPractice)';
  END IF;

  IF NEW.fee_percent IS DISTINCT FROM OLD.fee_percent THEN
    RAISE EXCEPTION
      'practices.fee_percent is set only by changePracticeFeePercent';
  END IF;

  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION
      'practices.approved_at is set only by approvePractice';
  END IF;

  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION
      'practices.approved_by is set only by approvePractice';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION protect_practices_columns() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_protect_practices_columns ON practices;
CREATE TRIGGER trg_protect_practices_columns
  BEFORE INSERT OR UPDATE ON practices
  FOR EACH ROW
  EXECUTE FUNCTION protect_practices_columns();

DROP POLICY IF EXISTS "authenticated_insert_practice" ON practices;

COMMENT ON FUNCTION protect_practices_columns() IS
  'Column lock for practices. As of 0135 it fires on INSERT as well as '
  'UPDATE: a practice created from a user session must start at pending, '
  'unapproved, at the default fee. Before that it was UPDATE-only, so '
  'status=''approved'' at creation produced a trading merchant that no '
  'admin ever saw (audit R3-02). Bypassed by service_role / '
  'app.privileged_write.';
