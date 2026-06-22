-- ─── Column-lock the owner-writable RLS pattern ──────────────────────────
--
-- The adversarial audit (2026-06-21) found that `USING (id = auth.uid())
-- WITH CHECK (id = auth.uid())` lets the owner write EVERY column on
-- their own row, including ones that should never be patient-editable
-- (role, email, phone_verified_at, fee_percent, status, approved_at,
-- approved_by). Postgres RLS has no column-level restriction inside a
-- policy and WITH CHECK can't compare old-vs-new — so we close the gap
-- with BEFORE UPDATE triggers that reject changes to protected
-- columns unless the write is on a privileged path.
--
-- Two privileged signals:
--   1. `auth.role() = 'service_role'` — the service-role client used
--      by checkout/initiateCheckout's profile upsert, /verify-phone's
--      profile UPDATE, and the new admin server actions (see Step 2
--      of this fix). When called via PostgREST with the service-role
--      key, `auth.role()` returns 'service_role'.
--   2. `current_setting('app.privileged_write', true) = 'on'` — a
--      transaction-local flag. SECURITY DEFINER RPCs that legitimately
--      set a protected column call `perform set_config('app.privileged
--      _write', 'on', true)` before their UPDATE. The `true` third arg
--      scopes it to the current transaction so the flag can't leak.
--
-- Either signal permits the write; otherwise the trigger raises and
-- the UPDATE is rejected before any row mutates.
--
-- ALSO in this migration — the C2 audit-trail gap: a row-level
-- trigger writes `admin_audit_log` for every fee_percent / status
-- change, regardless of caller. The existing changePracticeFeePercent
-- server action already logs from app code, but its log fires only on
-- the action's path; direct-table updates (including admin-action
-- updates that we're about to route through the service-role client)
-- need their own audit trail. Belt-and-braces.

-- ── 1. Protect profiles: role, email, phone_verified_at ─────────────────
--
-- Writers that pass this lock today:
--   • app/checkout/[token]/actions.ts initiateCheckout — upserts profile
--     via the service-role client (role + email + phone_verified_at).
--   • app/(auth)/verify-phone/actions.ts verifyPhoneOtpForUser — sets
--     phone_verified_at via the service-role client.
--   • The handle_new_user() trigger from 0024 — INSERT, not UPDATE, so
--     this BEFORE UPDATE trigger is not engaged.
--
-- Session-client writes that EXIST and continue to work (they don't
-- touch protected columns):
--   • /patient/profile/page.tsx updateProfile  — phone + address fields.
--   • /provider/profile/page.tsx                — phone only.
--   • /provider/setup/page.tsx                   — must_change_password.
--   • /patient/page.tsx saveSalaryDay            — salary_day.
--   • /patient/passkey-actions.ts                — passkey dismissal counter.
--
-- profiles.phone is INTENTIONALLY NOT protected here — patients edit
-- their own phone via /patient/profile and providers via
-- /provider/profile. The SMS-burn fix (Step 3) instead enforces "the
-- phone you verify must match your profile phone" inside the OTP RPCs.

CREATE OR REPLACE FUNCTION protect_profiles_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Privileged paths: service-role caller OR a SECURITY DEFINER RPC
  -- that opted in via set_config. Either bypasses the column lock.
  IF auth.role() = 'service_role'
     OR current_setting('app.privileged_write', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION
      'profiles.role is not user-editable (privilege escalation guard)';
  END IF;

  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION
      'profiles.email must be changed via the auth.users email-change ceremony';
  END IF;

  IF NEW.phone_verified_at IS DISTINCT FROM OLD.phone_verified_at THEN
    RAISE EXCEPTION
      'profiles.phone_verified_at is set only by the OTP verification path';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profiles_columns ON profiles;
CREATE TRIGGER trg_protect_profiles_columns
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION protect_profiles_columns();

COMMENT ON FUNCTION protect_profiles_columns() IS
  'Column-lock for profiles. Rejects user-initiated writes to role / '
  'email / phone_verified_at. Bypassed for service-role and for '
  'SECURITY DEFINER RPCs that opt in via set_config(''app.privileged_'
  'write'', ''on'', true). See migration 0054 header for rationale.';

-- ── 2. Protect practices: status, approved_at, approved_by, fee_percent ─
--
-- Writers that pass this lock after Step 2 of this fix:
--   • app/admin/practices/actions.ts approvePractice (switched to svc).
--   • app/admin/practices/actions.ts suspendPractice (switched to svc).
--   • app/admin/_lib/auditActions.ts changePracticeFeePercent (switched
--     to svc).
--   • app/signup/practice/actions.ts INSERT  — INSERT, not UPDATE.
--
-- Practice-admin direct-table updates are exactly the C2 attack
-- (self-approve, zero fee) and are correctly blocked.

CREATE OR REPLACE FUNCTION protect_practices_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role'
     OR current_setting('app.privileged_write', true) = 'on' THEN
    RETURN NEW;
  END IF;

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

DROP TRIGGER IF EXISTS trg_protect_practices_columns ON practices;
CREATE TRIGGER trg_protect_practices_columns
  BEFORE UPDATE ON practices
  FOR EACH ROW
  EXECUTE FUNCTION protect_practices_columns();

COMMENT ON FUNCTION protect_practices_columns() IS
  'Column-lock for practices. Rejects practice-admin writes to status / '
  'approved_at / approved_by / fee_percent. Same privileged-path bypass '
  'as protect_profiles_columns(). See migration 0054 header.';

-- ── 3. Audit trail for status / fee_percent changes (defence in depth) ──
--
-- The existing changePracticeFeePercent server action already inserts an
-- admin_audit_log row alongside its UPDATE. This trigger is the
-- belt-and-braces backup — ANY status or fee_percent change captures an
-- audit entry, even if some future code path forgets to log explicitly.
--
-- Same admin_audit_log schema the action uses (see 0048):
--   • action='fee_changed'      payload={ from, to }
--   • action='status_changed'   payload={ from, to }
--
-- actor_id: best effort. The server action passes the calling user via
-- auth.uid(); for service-role writes (where auth.uid() returns NULL)
-- we use the practice's owner_id as a placeholder. If actor_id ends up
-- NULL the row would violate the NOT NULL constraint, so we use the
-- placeholder; the action's own audit insert remains the authoritative
-- attribution.

CREATE OR REPLACE FUNCTION log_practice_protected_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID;
BEGIN
  -- actor_id: prefer the calling auth user; fall back to the practice's
  -- owner so the NOT NULL constraint never blocks a legitimate write.
  v_actor := COALESCE(auth.uid(), NEW.owner_id, OLD.owner_id);
  IF v_actor IS NULL THEN
    -- No identifiable actor + no owner — extremely unlikely (practice
    -- rows always carry owner_id at INSERT). Skip the audit row rather
    -- than failing the UPDATE.
    RETURN NEW;
  END IF;

  IF NEW.fee_percent IS DISTINCT FROM OLD.fee_percent THEN
    INSERT INTO admin_audit_log (actor_id, entity_type, entity_id, action, payload)
    VALUES (
      v_actor,
      'practice',
      NEW.id,
      'fee_changed',
      jsonb_build_object('from', OLD.fee_percent, 'to', NEW.fee_percent)
    );
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO admin_audit_log (actor_id, entity_type, entity_id, action, payload)
    VALUES (
      v_actor,
      'practice',
      NEW.id,
      'status_changed',
      jsonb_build_object('from', OLD.status, 'to', NEW.status)
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Allow the new action='status_changed' value the trigger writes.
-- admin_audit_log.action is plain TEXT (no CHECK constraint) per 0048,
-- so no schema change is needed for the new value.

DROP TRIGGER IF EXISTS trg_log_practice_protected_changes ON practices;
CREATE TRIGGER trg_log_practice_protected_changes
  AFTER UPDATE ON practices
  FOR EACH ROW
  EXECUTE FUNCTION log_practice_protected_changes();

COMMENT ON FUNCTION log_practice_protected_changes() IS
  'Writes admin_audit_log for any change to practices.fee_percent or '
  'practices.status, regardless of which path drove the write. Audit '
  'defence in depth — the existing changePracticeFeePercent action '
  'also logs explicitly; this trigger catches any path that doesn''t.';
