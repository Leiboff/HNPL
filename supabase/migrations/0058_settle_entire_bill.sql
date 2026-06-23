-- ─── Single-charge "Settle entire bill" — settlement row model ──────────
--
-- Replaces the per-row loop with ONE Paystack charge for the summed
-- total of all outstanding instalments on a plan. Preserves the
-- webhook's existing 1:1 (peach_payment_id → payment row) routing by
-- using the `payments` table for the settlement record: a new row with
-- kind='settlement' that Paystack charges and the webhook closes out
-- against all the instalments it covered.
--
-- All-or-nothing semantics: voluntary "settle everything" either
-- succeeds in full or fails in full. The settlement row's lifecycle
-- mirrors a normal payment row — processing → collected on
-- charge.success, processing → failed on charge.failed — except that
-- on collected, every covered instalment also flips to collected; on
-- failed, every covered instalment reverts to its pre-settlement
-- status (recorded on the settlement row before claiming).
--
-- Idempotency / no double-charge: the multi-row atomic claim
-- (claim_plan_for_settlement below) flips every eligible instalment to
-- 'processing' in one UPDATE BEFORE the Paystack charge fires. A
-- concurrent cron attempt that grabs any covered row first wins its
-- per-row atomic claim, and the multi-row claim notices its UPDATE
-- claimed fewer rows than expected, reverts the partial claim, and
-- returns 'race_lost'.

-- ── 1. payments — settlement-row columns ────────────────────────────────

-- 'instalment' (the existing rows) vs 'settlement' (the new single-row
-- representation of a settle-entire-bill charge). The cron + webhook
-- filter by this so a settlement row is never picked up by the
-- collect-instalments cron and never advances the dunning ladder.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'instalment';

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_kind_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_kind_check
  CHECK (kind IN ('instalment', 'settlement'));

-- On a covered instalment, points at the settlement payment row that
-- claimed (and on charge.success will collect) it. NULL on the
-- settlement row itself and on instalments never settled this way.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS settled_by_payment_id UUID
    REFERENCES payments(id);

CREATE INDEX IF NOT EXISTS payments_settled_by_payment_id_idx
  ON payments (settled_by_payment_id)
  WHERE settled_by_payment_id IS NOT NULL;

-- On the settlement row: JSONB { paymentId: { status, amount, dunning_fees_cents }, ... }
-- captured at claim time. Used to revert covered rows to their original
-- statuses if the settlement charge fails.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS pre_settlement_snapshot JSONB;

-- ── 2. claim_plan_for_settlement(plan_id, patient_id, today) ────────────
--
-- SECURITY DEFINER atomic claim. The whole multi-row claim + settlement
-- row insert happens inside one function (= one Postgres transaction),
-- so a partial claim can't leak: if any eligible row was grabbed by a
-- concurrent cron between the snapshot and the claim UPDATE, the
-- ROW_COUNT < expected check triggers a clean revert (restore prior
-- statuses, delete the settlement row).
--
-- Returns one of:
--   { ok: true, settlement_id, amount_cents, covered_count }
--   { ok: false, error: 'plan_not_found' }
--   { ok: false, error: 'unauthorized'   }
--   { ok: false, error: 'nothing_to_settle' }
--   { ok: false, error: 'race_lost'      }
--
-- The patient calls this via a server action wrapping a service-role
-- client. SECURITY DEFINER on this function does the auth check
-- against p_patient_id (re-verified against the plan owner) — the
-- caller must pass the authenticated user's id, which the server
-- action sources from `auth.uid()` via the session client.

CREATE OR REPLACE FUNCTION claim_plan_for_settlement(
  p_plan_id    UUID,
  p_patient_id UUID,
  p_today      DATE
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
  --       processing / written_off. Sums amount + dunning_fees_cents
  --       per row into total cents.
  SELECT
    array_agg(id),
    jsonb_object_agg(id::text, jsonb_build_object(
      'status',             status,
      'amount',             amount,
      'dunning_fees_cents', COALESCE(dunning_fees_cents, 0)
    )),
    SUM(ROUND(amount * 100)::BIGINT + COALESCE(dunning_fees_cents, 0)::BIGINT)
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
GRANT EXECUTE ON FUNCTION claim_plan_for_settlement(UUID, UUID, DATE) TO service_role;
REVOKE EXECUTE ON FUNCTION claim_plan_for_settlement(UUID, UUID, DATE) FROM PUBLIC;

COMMENT ON FUNCTION claim_plan_for_settlement(UUID, UUID, DATE) IS
  'Server-side atomic claim for "Settle entire bill". Snapshots every '
  'eligible instalment, inserts a settlement payment row, flips every '
  'eligible instalment to processing in one UPDATE, and reverts cleanly '
  'on race-loss. Returns {ok,settlement_id,amount_cents,covered_count} '
  'or {ok:false,error}. See lib/payments/selfSettleEntirePlan.ts.';
