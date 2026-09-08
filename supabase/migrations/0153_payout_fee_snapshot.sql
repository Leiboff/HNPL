-- Fail closed when the contractual practice fee cannot be read, and retain the
-- exact rate used for every new immutable payout calculation.

ALTER TABLE payouts
  ADD COLUMN fee_percent_snapshot NUMERIC(5,2);

ALTER TABLE payouts
  ADD CONSTRAINT payouts_fee_percent_snapshot_valid
  CHECK (
    fee_percent_snapshot IS NULL
    OR fee_percent_snapshot BETWEEN 0 AND 100
  );

COMMENT ON COLUMN payouts.fee_percent_snapshot IS
  'Contractual practice fee percentage used to calculate this payout. NULL only for historical payouts created before migration 0153.';

CREATE OR REPLACE FUNCTION activate_first_instalment(
  p_payment_id UUID,
  p_plan_id UUID,
  p_collected_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan plans%ROWTYPE;
  v_payment payments%ROWTYPE;
  v_fee practices.fee_percent%TYPE;
  v_provider UUID;
  v_fee_amount NUMERIC(10,2);
BEGIN
  SELECT * INTO v_plan FROM plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND OR v_plan.status NOT IN ('pending_first_payment', 'active') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'plan_not_activatable');
  END IF;

  SELECT * INTO v_payment FROM payments
   WHERE id = p_payment_id AND plan_id = p_plan_id AND instalment_number = 1
   FOR UPDATE;
  IF NOT FOUND OR v_payment.status NOT IN ('processing', 'collected') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payment_not_collectable');
  END IF;

  -- SELECT STRICT makes both a missing practice and an unexpectedly ambiguous
  -- lookup an error path. No fee default is appropriate during activation.
  BEGIN
    SELECT fee_percent INTO STRICT v_fee
      FROM practices
     WHERE id = v_plan.practice_id;
  EXCEPTION
    WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RETURN jsonb_build_object('ok', false, 'error', 'fee_unavailable');
  END;

  -- PostgreSQL numeric admits special non-finite values. Reject those
  -- explicitly as well as out-of-contract rates.
  IF v_fee IS NULL
     OR v_fee::TEXT IN ('NaN', 'Infinity', '-Infinity')
     OR v_fee < 0 OR v_fee > 100 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'fee_unavailable');
  END IF;

  IF v_plan.provider_member_id IS NOT NULL THEN
    SELECT user_id INTO v_provider FROM practice_members
     WHERE id = v_plan.provider_member_id AND practice_id = v_plan.practice_id;
  END IF;

  v_fee_amount := ROUND(v_plan.total_amount * v_fee / 100, 2);

  UPDATE payments
     SET status = 'collected', collected_at = COALESCE(collected_at, p_collected_at, now())
   WHERE id = p_payment_id;
  UPDATE plans SET status = 'active' WHERE id = p_plan_id;

  INSERT INTO payouts (
    id, practice_id, plan_id, provider_id, gross_amount, fee_percent_snapshot,
    fee_amount, net_amount, status, payout_destination
  ) VALUES (
    gen_random_uuid(), v_plan.practice_id, v_plan.id, v_provider,
    v_plan.total_amount, v_fee, v_fee_amount, v_plan.total_amount - v_fee_amount,
    'pending', 'practice'
  ) ON CONFLICT (plan_id) DO NOTHING;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION activate_first_instalment(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION activate_first_instalment(UUID, UUID, TIMESTAMPTZ) TO service_role;
  END IF;
END;
$$;

COMMENT ON FUNCTION activate_first_instalment(UUID, UUID, TIMESTAMPTZ) IS
  'Atomic first-payment activation. Fails closed unless the practice fee is present and valid, and snapshots that rate on the unique payout.';
