-- ─── The admin actions that move money now leave a record ──────────────────
--
-- THE DEFECT (audit 2026-09-02, A-12)
--
-- 0048 built the right table with the right policy — is_platform_admin()
-- AND actor_id = auth.uid(), so a client cannot forge attribution — and then
-- almost nothing was wired into it. Two actions wrote to admin_audit_log:
-- addNote and changePracticeFeePercent. Unrecorded:
--
--   • marking a payout batch PAID — the assertion that money left the bank
--   • marking a single payout paid
--   • retrying a collection — a real card charge
--   • granting or revoking the 'sales' role — read access to the whole CRM
--   • changing a practice's or a group's banking details — WHERE the money
--     goes
--   • granting or revoking brand-admin on a group
--
-- The scenario that matters is not exotic: change a practice's banking
-- details, wait for the Friday EFT, change them back. Nothing in the
-- database recorded who did it or when. Vercel request logs carry no actor
-- identity and roll off.
--
-- ─── WHY TRIGGERS AND NOT ONLY CALL-SITE INSERTS ───────────────────────────
--
-- Both, deliberately, because they fail in opposite directions.
--
-- A call-site insert knows WHO (the server action has just authenticated the
-- caller) and knows the INTENT (a card retry is not a column change and
-- cannot be triggered on at all). It can be forgotten by the next code path
-- that writes the same row.
--
-- A trigger cannot be forgotten — it fires for the cron, for a psql session,
-- for a future action nobody has written yet — but under a service-role
-- connection auth.uid() is NULL and it cannot name the actor.
--
-- So: triggers record that the change HAPPENED, for every column change that
-- is itself the event (banking, role, payout settlement). Call sites record
-- WHO, for the paths that have an authenticated caller. Where both fire you
-- get two rows for one event, and that is the intended outcome — the pair is
-- what makes a missing half visible.
--
-- ─── actor_id BECOMES NULLABLE, AND 0054'S PLACEHOLDER GOES ────────────────
--
-- 0054's trigger could not attribute a service-role write either, and rather
-- than say so it fell back to `NEW.owner_id` — the practice's OWNER. So an
-- admin's fee change was recorded against the practice owner, and an audit
-- trail that names the wrong person is worse than one that says "unknown":
-- the first is evidence against someone innocent, the second is a prompt to
-- go and look at the request logs.
--
-- actor_id is therefore nullable, NULL meaning "no identifiable actor on
-- this connection". The RLS INSERT policy is unchanged and still requires
-- actor_id = auth.uid(), which is NULL = NULL → NULL → not true, so a client
-- still cannot insert an unattributed row. Only SECURITY DEFINER triggers
-- and service_role can, which is exactly who should be able to.

-- ── 1. Room for the entities this now covers ───────────────────────────────
--
-- entity_id carries no FK (0048's choice — one column pointing at six
-- tables), so this is only about the CHECK.
--
-- A role change is recorded against 'customer', not a new 'user' type, even
-- though the person is being made staff. entity_id is profiles.id either way,
-- and the admin customer page reads entity_type='customer' — so the grant
-- shows up on that person's own timeline, which is where somebody looking
-- into them will actually look.

ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_entity_type_check;
ALTER TABLE admin_audit_log ADD  CONSTRAINT admin_audit_log_entity_type_check
  CHECK (entity_type IN (
    'practice',
    'customer',
    'practice_group',
    'payout',
    'payout_batch',
    'payment'
  ));

ALTER TABLE admin_audit_log ALTER COLUMN actor_id DROP NOT NULL;

COMMENT ON COLUMN admin_audit_log.actor_id IS
  'The admin who performed the action, or NULL when the write arrived on a '
  'connection with no auth.uid() (service-role, cron, psql). NULL means '
  '"unattributed", never "the system did it" — go and correlate the request '
  'logs. Never substitute a placeholder here.';

COMMENT ON COLUMN admin_audit_log.entity_type IS
  'practice | customer | practice_group | payout | payout_batch | payment. '
  'A role grant is recorded against customer (entity_id = profiles.id) so it '
  'lands on that person''s own admin timeline.';

-- Shared payload builder — practices and practice_groups carry the identical
-- five columns, and two copies of the redaction rule is one copy too many.
CREATE OR REPLACE FUNCTION audit_banking_payload(
  old_bank_name TEXT, old_account TEXT, old_branch TEXT, old_holder TEXT, old_type TEXT,
  new_bank_name TEXT, new_account TEXT, new_branch TEXT, new_holder TEXT, new_type TEXT
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'from', jsonb_build_object(
      'bank_name',      old_bank_name,
      'branch_code',    old_branch,
      'account_holder', old_holder,
      'account_type',   old_type,
      'account_last4',  CASE WHEN old_account IS NULL THEN NULL
                             ELSE RIGHT(old_account, 4) END,
      'account_sha256', CASE WHEN old_account IS NULL THEN NULL
                             ELSE encode(sha256(old_account::bytea), 'hex') END
    ),
    'to', jsonb_build_object(
      'bank_name',      new_bank_name,
      'branch_code',    new_branch,
      'account_holder', new_holder,
      'account_type',   new_type,
      'account_last4',  CASE WHEN new_account IS NULL THEN NULL
                             ELSE RIGHT(new_account, 4) END,
      'account_sha256', CASE WHEN new_account IS NULL THEN NULL
                             ELSE encode(sha256(new_account::bytea), 'hex') END
    )
  );
$$;

COMMENT ON FUNCTION audit_banking_payload(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) IS
  'from/to payload for a banking change. The account number is reduced to '
  'its last four digits plus a SHA-256, so "changed and changed back" is '
  'still provable without admin_audit_log becoming a permanent store of '
  'bank account numbers.';

-- ── 2. Banking changes on a practice ───────────────────────────────────────
--
-- Extends 0054's trigger rather than adding a second one on the same table,
-- so the ordering of the two audit rows a combined write produces stays
-- defined.
--
-- ON NOT STORING THE ACCOUNT NUMBER
--
-- The payload carries the last four digits and a SHA-256 of the full number,
-- never the number itself. admin_audit_log is append-only and readable by
-- every platform admin, so writing bank account numbers into it would create
-- a permanent, ever-growing store of them that no rotation can clean up.
--
-- The digest is not decoration: the scenario this exists to catch is
-- "changed to a mule account, waited for the EFT, changed back", and
-- detecting it means comparing values ACROSS TIME. Equal digests prove the
-- number returned to what it was; different digests prove it did not. That
-- is the whole forensic question, and it is answerable without keeping the
-- number.
--
-- pgcrypto's digest() is not assumed — sha256() is core Postgres 11+.

CREATE OR REPLACE FUNCTION log_practice_protected_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID;
BEGIN
  -- No COALESCE to owner_id any more. See the header: an audit row naming
  -- the wrong person is worse than one naming nobody.
  v_actor := auth.uid();

  IF NEW.fee_percent IS DISTINCT FROM OLD.fee_percent THEN
    INSERT INTO admin_audit_log (actor_id, entity_type, entity_id, action, payload)
    VALUES (
      v_actor, 'practice', NEW.id, 'fee_changed',
      jsonb_build_object('from', OLD.fee_percent, 'to', NEW.fee_percent)
    );
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO admin_audit_log (actor_id, entity_type, entity_id, action, payload)
    VALUES (
      v_actor, 'practice', NEW.id, 'status_changed',
      jsonb_build_object('from', OLD.status, 'to', NEW.status)
    );
  END IF;

  -- Where the money goes. One row for the whole tuple rather than one per
  -- column: banking is changed as a unit and read as a unit, and five rows
  -- for one edit would bury the event it is meant to surface.
  IF (NEW.bank_account_number IS DISTINCT FROM OLD.bank_account_number)
     OR (NEW.branch_code    IS DISTINCT FROM OLD.branch_code)
     OR (NEW.bank_name      IS DISTINCT FROM OLD.bank_name)
     OR (NEW.account_holder IS DISTINCT FROM OLD.account_holder)
     OR (NEW.account_type   IS DISTINCT FROM OLD.account_type)
  THEN
    INSERT INTO admin_audit_log (actor_id, entity_type, entity_id, action, payload)
    VALUES (
      v_actor, 'practice', NEW.id, 'banking_changed',
      audit_banking_payload(
        OLD.bank_name, OLD.bank_account_number, OLD.branch_code,
        OLD.account_holder, OLD.account_type,
        NEW.bank_name, NEW.bank_account_number, NEW.branch_code,
        NEW.account_holder, NEW.account_type
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Recreate the trigger so a re-run of this migration re-points it at the
-- current function definition.
DROP TRIGGER IF EXISTS trg_log_practice_protected_changes ON practices;
CREATE TRIGGER trg_log_practice_protected_changes
  AFTER UPDATE ON practices
  FOR EACH ROW
  EXECUTE FUNCTION log_practice_protected_changes();

-- ── 3. Banking changes on a group ──────────────────────────────────────────
--
-- practice_groups is the brand-level fallback account: a branch with no
-- banking of its own settles here (resolvePayoutBanking), so changing this
-- row can redirect the money of every branch under the brand at once. It had
-- no trigger at all.

CREATE OR REPLACE FUNCTION log_practice_group_banking_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.bank_account_number IS DISTINCT FROM OLD.bank_account_number)
     OR (NEW.branch_code    IS DISTINCT FROM OLD.branch_code)
     OR (NEW.bank_name      IS DISTINCT FROM OLD.bank_name)
     OR (NEW.account_holder IS DISTINCT FROM OLD.account_holder)
     OR (NEW.account_type   IS DISTINCT FROM OLD.account_type)
  THEN
    INSERT INTO admin_audit_log (actor_id, entity_type, entity_id, action, payload)
    VALUES (
      auth.uid(), 'practice_group', NEW.id, 'banking_changed',
      audit_banking_payload(
        OLD.bank_name, OLD.bank_account_number, OLD.branch_code,
        OLD.account_holder, OLD.account_type,
        NEW.bank_name, NEW.bank_account_number, NEW.branch_code,
        NEW.account_holder, NEW.account_type
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_practice_group_banking ON practice_groups;
CREATE TRIGGER trg_log_practice_group_banking
  AFTER UPDATE ON practice_groups
  FOR EACH ROW
  EXECUTE FUNCTION log_practice_group_banking_changes();

-- ── 4. Role changes ────────────────────────────────────────────────────────
--
-- 'sales' confers read access to the entire CRM — every lead, every practice
-- pipeline. 'admin' confers everything. Both were grantable with no record.
--
-- Fires on ANY role transition, including ones no current code path
-- performs (patient → admin), because the point of the trigger half is the
-- path nobody has written yet. 0054's protect_profiles_columns() already
-- restricts WHO may write the column; this records that they did.

CREATE OR REPLACE FUNCTION log_profile_role_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    INSERT INTO admin_audit_log (actor_id, entity_type, entity_id, action, payload)
    VALUES (
      auth.uid(), 'customer', NEW.id, 'role_changed',
      jsonb_build_object('from', OLD.role, 'to', NEW.role)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_profile_role_changes ON profiles;
CREATE TRIGGER trg_log_profile_role_changes
  AFTER UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION log_profile_role_changes();

-- ── 5. Settlement ──────────────────────────────────────────────────────────
--
-- "Marked paid" is an ASSERTION BY A HUMAN that an EFT left the bank —
-- nothing in this system talks to a bank, so the flip is the only evidence
-- the payment happened, and until now it was evidence with no signature.
--
-- Scoped to transitions INTO 'paid'. A payout row moves pending → paid once,
-- by an admin; it is created by the activation webhook (an INSERT, not
-- matched here) and batched by the weekly cron (a batch_id change, not a
-- status change). So this logs admin settlement and essentially nothing
-- else, which is what keeps it readable.

CREATE OR REPLACE FUNCTION log_payout_settlement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    INSERT INTO admin_audit_log (actor_id, entity_type, entity_id, action, payload)
    VALUES (
      auth.uid(),
      TG_ARGV[0],
      NEW.id,
      'marked_paid',
      jsonb_build_object(
        'from',        OLD.status,
        'practice_id', NEW.practice_id,
        'paid_at',     NEW.paid_at,
        -- payouts carry net_amount; batches carry total_net. Whichever this
        -- row has is the rand figure an auditor would reconcile against a
        -- bank statement.
        'amount',      COALESCE(
                         to_jsonb(NEW) -> 'net_amount',
                         to_jsonb(NEW) -> 'total_net'
                       )
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_payout_settlement ON payouts;
CREATE TRIGGER trg_log_payout_settlement
  AFTER UPDATE ON payouts
  FOR EACH ROW
  EXECUTE FUNCTION log_payout_settlement('payout');

DROP TRIGGER IF EXISTS trg_log_payout_batch_settlement ON payout_batches;
CREATE TRIGGER trg_log_payout_batch_settlement
  AFTER UPDATE ON payout_batches
  FOR EACH ROW
  EXECUTE FUNCTION log_payout_settlement('payout_batch');

-- ── 6. EXECUTE stays an allow-list (0125) ──────────────────────────────────
--
-- 0125 made EXECUTE opt-in rather than public, and these functions are not
-- in the allow-list: nothing should CALL them, only the triggers should fire
-- them, and a trigger does not check EXECUTE on its function. Revoked
-- explicitly anyway, so the property is stated here rather than inherited
-- from a default that a later migration could change.

REVOKE ALL ON FUNCTION log_practice_protected_changes()       FROM PUBLIC;
REVOKE ALL ON FUNCTION log_practice_group_banking_changes()   FROM PUBLIC;
REVOKE ALL ON FUNCTION log_profile_role_changes()             FROM PUBLIC;
REVOKE ALL ON FUNCTION log_payout_settlement()                FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_banking_payload(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;

COMMENT ON FUNCTION log_practice_group_banking_changes() IS
  'Audits any change to a group''s central banking — the fallback account '
  'every branch without its own settles to.';
COMMENT ON FUNCTION log_profile_role_changes() IS
  'Audits any profiles.role transition. sales grants CRM-wide read.';
COMMENT ON FUNCTION log_payout_settlement() IS
  'Audits a payout or batch moving into ''paid'' — the human assertion that '
  'an EFT left the bank. TG_ARGV[0] is the entity_type to record.';
