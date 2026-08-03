-- ─── Fee gate for "Settle entire bill" — p_include_fees param ───────────
--
-- Compliance: default dunning fees may not be CHARGED until disclosed +
-- accepted T&Cs are persisted (see lib/payments/dunning.ts
-- dunningFeesEnabled()). The per-instalment charge path gates fees in
-- app code (lib/payments/chargeInstalment.ts). The "settle entire bill"
-- path bakes fees into the settlement row's amount INSIDE this RPC
-- (0058), so the gate has to live here too — otherwise a patient
-- settling everything could still be charged a legacy accrued fee.
--
-- Change: add p_include_fees BOOLEAN. When false (gate OFF) the summed
-- settlement total EXCLUDES dunning_fees_cents — the patient is charged
-- instalment principal only. The per-row SNAPSHOT still records the real
-- dunning_fees_cents (revert accuracy is unaffected), and the claim /
-- race-loss / revert logic is BYTE-IDENTICAL to 0058 — only the total
-- SUM expression is gated. Money-path idempotency is preserved.
--
-- Signature change (3-arg → 4-arg) => DROP the old overload then CREATE,
-- re-granting execute to service_role. The only caller
-- (lib/payments/selfSettleEntirePlan.ts) is updated in the same branch
-- to pass p_include_fees = dunningFeesEnabled().

DROP FUNCTION IF EXISTS claim_plan_for_settlement(UUID, UUID, DATE);

CREATE OR REPLACE FUNCTION claim_plan_for_settlement(
  p_plan_id      UUID,
  p_patient_id   UUID,
  p_today        DATE,
  p_include_fees BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eligible_ids        UUID[];
  v_eligible_snapshot   JSONB;
  v_total_cents         BIGINT;
  v_settlement_id       UUID;
  v_claimed_count       INT;
  v_expected_count      INT;
BEGIN
  -- ── 1. Ownership gate. The patient must own the plan; the session
  --       client supplies the patient id, the function re-verifies.
  IF NOT EXISTS (
    SELECT 1 FROM plans
     WHERE id = p_plan_id
       AND patient_id = p_patient_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'plan_not_found');
  END IF;

  -- ── 2. Snapshot eligible instalments. Excludes settlement rows
  --       (kind='settlement') and any row already collected /
  --       processing / written_off. The SNAPSHOT always records the
  --       real dunning_fees_cents (so a revert restores accurately);
  --       the charged TOTAL includes fees only when p_include_fees.
  SELECT
    array_agg(id),
    jsonb_object_agg(id::text, jsonb_build_object(
      'status',             status,
      'amount',             amount,
      'dunning_fees_cents', COALESCE(dunning_fees_cents, 0)
    )),
    SUM(
      ROUND(amount * 100)::BIGINT
      + CASE WHEN p_include_fees THEN COALESCE(dunning_fees_cents, 0)::BIGINT ELSE 0 END
    )
  INTO v_eligible_ids, v_eligible_snapshot, v_total_cents
  FROM payments
  WHERE plan_id = p_plan_id
    AND kind   = 'instalment'
    AND status IN ('scheduled', 'failed', 'defaulted');

  IF v_eligible_ids IS NULL OR array_length(v_eligible_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'nothing_to_settle');
  END IF;

  v_expected_count := array_length(v_eligible_ids, 1);
  v_settlement_id  := gen_random_uuid();

  -- ── 3. Insert the settlement row. instalment_number = 0 is the
  --       sentinel for settlement rows (the column is NOT NULL from
  --       0001; 0 doesn't collide with any real instalment).
  INSERT INTO payments (
    id, plan_id, patient_id, instalment_number, amount,
    due_date, status, kind, pre_settlement_snapshot
  )
  VALUES (
    v_settlement_id,
    p_plan_id,
    p_patient_id,
    0,
    v_total_cents::NUMERIC / 100,
    p_today,
    'processing',
    'settlement',
    v_eligible_snapshot
  );

  -- ── 4. Atomic multi-row claim. The WHERE re-checks status against
  --       the eligible set, so a concurrent cron claim that already
  --       flipped a row to 'processing' will cause this UPDATE to
  --       skip that row, and v_claimed_count < v_expected_count.
  UPDATE payments
  SET status                    = 'processing',
      settled_by_payment_id     = v_settlement_id,
      last_dunning_attempt_date = p_today
  WHERE id = ANY(v_eligible_ids)
    AND kind = 'instalment'
    AND status IN ('scheduled', 'failed', 'defaulted');

  GET DIAGNOSTICS v_claimed_count = ROW_COUNT;

  -- ── 5. Partial-claim revert. Couldn't grab every eligible row →
  --       race lost. Restore the rows WE did claim to their prior
  --       status (read from the snapshot we wrote on the settlement
  --       row), then delete the settlement row. The settle-all then
  --       aborts cleanly; the patient sees "try again in a moment".
  IF v_claimed_count != v_expected_count THEN
    UPDATE payments
    SET status                = v_eligible_snapshot -> payments.id::text ->> 'status',
        settled_by_payment_id = NULL
    WHERE settled_by_payment_id = v_settlement_id
      AND status = 'processing';

    DELETE FROM payments WHERE id = v_settlement_id;

    RETURN jsonb_build_object('ok', false, 'error', 'race_lost');
  END IF;

  RETURN jsonb_build_object(
    'ok',             true,
    'settlement_id',  v_settlement_id,
    'amount_cents',   v_total_cents,
    'covered_count',  v_claimed_count
  );
END;
$$;

-- Grants — service-role calls this via the server action's service-role
-- client. The function itself does the ownership check.
GRANT EXECUTE ON FUNCTION claim_plan_for_settlement(UUID, UUID, DATE, BOOLEAN) TO service_role;
REVOKE EXECUTE ON FUNCTION claim_plan_for_settlement(UUID, UUID, DATE, BOOLEAN) FROM PUBLIC;

COMMENT ON FUNCTION claim_plan_for_settlement(UUID, UUID, DATE, BOOLEAN) IS
  'Server-side atomic claim for "Settle entire bill". Snapshots every '
  'eligible instalment, inserts a settlement payment row, flips every '
  'eligible instalment to processing in one UPDATE, and reverts cleanly '
  'on race-loss. p_include_fees=false gates accrued dunning fees OUT of '
  'the charged total (compliance). Returns '
  '{ok,settlement_id,amount_cents,covered_count} or {ok:false,error}. '
  'See lib/payments/selfSettleEntirePlan.ts.';
