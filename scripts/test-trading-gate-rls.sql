-- ─── RLS-level test: trading gate blocks pending-practice direct inserts ────
--
-- Run after 0043_trading_gate_rls.sql has been applied:
--   supabase db query --file scripts/test-trading-gate-rls.sql
-- or paste into the Supabase SQL Editor and execute.
--
-- This proves the DATABASE rejects user-token inserts that bypass the
-- server action — not just that createBill() does. The whole script runs
-- inside a single transaction with ROLLBACK at the end, so no rows
-- survive even if you run it against the production database.
--
-- What it does, per scenario:
--   1. Creates a pending practice with an admin member (no providers).
--      Switches role to "authenticated" and forges the admin's JWT
--      claims so RLS evaluates as that user. Attempts an applications
--      insert → must FAIL with row-level-security or check constraint.
--      Same for plans.
--   2. Marks the practice approved but still without any provider.
--      Attempts the same inserts → must still FAIL (no_providers branch).
--   3. Adds a provider. Same inserts → must SUCCEED. Proves the gate
--      isn't permanently locked.
--
-- The expected RAISE NOTICEs at the end summarise the three scenarios.

BEGIN;

-- ── Fixture: synthetic admin + provider auth users + practice ──────────────
-- Inserting into auth.users requires service-role; this script must be run
-- with the service-role key (which the SQL Editor and `supabase db query`
-- use by default).

DO $$
DECLARE
  v_admin_id      uuid := gen_random_uuid();
  v_provider_id   uuid := gen_random_uuid();
  v_practice_id   uuid := gen_random_uuid();
  v_app_id_1      uuid := gen_random_uuid();
  v_app_id_2      uuid := gen_random_uuid();
  v_app_id_3      uuid := gen_random_uuid();
  v_plan_id_3     uuid := gen_random_uuid();
  v_failed        boolean;
  v_app_count     int;
  v_plan_count    int;
BEGIN
  -- auth.users rows (service-role inserts; bypasses RLS)
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at)
  VALUES
    (v_admin_id,    'gate-test-admin-'    || v_admin_id    || '@example.test',
       'x', NOW(), '{"role":"practice_admin","first_name":"Gate","last_name":"Admin"}'::jsonb, NOW()),
    (v_provider_id, 'gate-test-provider-' || v_provider_id || '@example.test',
       'x', NOW(), '{"role":"practice_provider","first_name":"Gate","last_name":"Doc"}'::jsonb, NOW());

  -- profiles trigger may have already inserted these; upsert into role.
  -- (handle_new_user creates profile from raw_user_meta_data.)

  -- Pending practice + admin member (no provider yet)
  INSERT INTO practices (id, owner_id, name, status, fee_percent, email, phone, address_line1, city, practice_province, suburb, postal_code, specialty)
  VALUES (v_practice_id, v_admin_id, 'Gate Test Practice', 'pending', 6.00,
          'gate-test-practice@example.test', '+27820000000', '1 Test', 'Joburg', 'Gauteng', 'Sandton', '2196', 'General Practice');

  INSERT INTO practice_members (practice_id, user_id, role, active, can_create_bills, can_manage_practice, payout_destination)
  VALUES (v_practice_id, v_admin_id, 'admin', true, true, true, 'practice');

  -- ── Scenario 1: pending + no providers → INSERT must FAIL ────────────────
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin_id, 'role', 'authenticated')::text, true);

  v_failed := false;
  BEGIN
    INSERT INTO applications (id, patient_id, practice_id, bill_amount, status)
    VALUES (v_app_id_1, NULL, v_practice_id, 1000, 'pending');
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'FAIL scenario 1 (pending, no providers): applications insert SUCCEEDED — RLS did not block it';
  END IF;
  RAISE NOTICE 'OK scenario 1 (pending, no providers): applications insert blocked by RLS';

  v_failed := false;
  BEGIN
    INSERT INTO plans (id, application_id, practice_id, provider_id, total_amount, status, invoice_number)
    VALUES (gen_random_uuid(), v_app_id_1, v_practice_id, v_provider_id, 1000, 'pending_acceptance', 'INV-TEST-1');
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'FAIL scenario 1 (pending, no providers): plans insert SUCCEEDED — RLS did not block it';
  END IF;
  RAISE NOTICE 'OK scenario 1 (pending, no providers): plans insert blocked by RLS';

  -- ── Scenario 2: approved + STILL no providers → INSERT must FAIL ─────────
  -- Service-role for the status update; auth context for the test insert.
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE practices SET status = 'approved' WHERE id = v_practice_id;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin_id, 'role', 'authenticated')::text, true);

  v_failed := false;
  BEGIN
    INSERT INTO applications (id, patient_id, practice_id, bill_amount, status)
    VALUES (v_app_id_2, NULL, v_practice_id, 1000, 'pending');
  EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'FAIL scenario 2 (approved, no providers): applications insert SUCCEEDED — RLS did not block it';
  END IF;
  RAISE NOTICE 'OK scenario 2 (approved, no providers): applications insert blocked by RLS';

  -- ── Scenario 3: approved + one active provider → INSERT must SUCCEED ─────
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO practice_members (practice_id, user_id, role, active, can_create_bills, can_manage_practice, payout_destination)
  VALUES (v_practice_id, v_provider_id, 'provider', true, false, false, 'practice');

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin_id, 'role', 'authenticated')::text, true);

  INSERT INTO applications (id, patient_id, practice_id, bill_amount, status)
  VALUES (v_app_id_3, NULL, v_practice_id, 1000, 'pending');

  INSERT INTO plans (id, application_id, practice_id, provider_id, total_amount, status, invoice_number)
  VALUES (v_plan_id_3, v_app_id_3, v_practice_id, v_provider_id, 1000, 'pending_acceptance', 'INV-TEST-3');

  RAISE NOTICE 'OK scenario 3 (approved, with provider): applications + plans insert succeeded';

  -- ── Sanity counts inside the transaction ─────────────────────────────────
  SELECT count(*) INTO v_app_count  FROM applications WHERE practice_id = v_practice_id;
  SELECT count(*) INTO v_plan_count FROM plans       WHERE practice_id = v_practice_id;
  IF v_app_count <> 1 OR v_plan_count <> 1 THEN
    RAISE EXCEPTION 'FAIL sanity: expected exactly 1 application and 1 plan, got app=% plan=%', v_app_count, v_plan_count;
  END IF;

  RAISE NOTICE 'All scenarios passed. (Transaction will ROLLBACK — no rows persist.)';
END;
$$;

ROLLBACK;
