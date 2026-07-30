-- Repoint refresh_card_token onto the Peach column + fix a pre-existing
-- cross-plan overwrite bug at the same time.
--
-- Two problems in the 0041 shape:
--
--   1. Column drift. Post-0076/0077 the live token column is
--      plans.peach_registration_id — chargeInstalment.ts, payWithSavedCard,
--      settle-actions.ts, and the Peach webhook all read from it.
--      The 0041 UPDATE targeted plans.paystack_authorization_code, which
--      no active code path reads. The card-token-refresh safety net was
--      therefore a silent no-op for every Peach plan — the cron would
--      keep charging the stale registrationId even after the same physical
--      card was re-vaulted with a new token.
--
--      Grep at commit time confirms zero TypeScript/JavaScript readers of
--      paystack_authorization_code. The column is dead schema kept for
--      historic rows; no backfill from it into peach_registration_id
--      happens in 0076 either (the migration explicitly leaves historic
--      Paystack plans on the old column and marks them
--      payment_provider = 'paystack'). Safe to stop writing to the
--      dead column.
--
--   2. Cross-plan overwrite. The 0041 WHERE scoped by patient_id + status
--      only. If a patient had two active plans on two DIFFERENT physical
--      cards, refreshing the default card would have repointed BOTH
--      plans' tokens onto the default's new value — the non-default
--      plan's cron would then charge the wrong card. Under the Paystack-
--      era "one authorization_code per patient" mental model this was
--      approximately right; under Peach (per-plan registrationId minted
--      at CIT time), it is not.
--
--      The correct scope is: only repoint plans whose CURRENT
--      peach_registration_id equals the OLD token on this payment_methods
--      row. Capture the old token before the payment_methods UPDATE and
--      use it in the plans UPDATE's WHERE.
--
--      Consequence for the is_default gate: it was Paystack-era heuristic
--      (only the default card's token was ever used for collections). Under
--      Peach every plan holds its own token regardless of default status —
--      the token-based scope makes is_default irrelevant. Drop the gate.
--
-- The payment_methods UPDATE + plan_events insert semantics are unchanged.
-- SECURITY DEFINER + search_path pin preserved. Grant unchanged
-- (service_role only, per the callsite in saveCardForPatient).

CREATE OR REPLACE FUNCTION refresh_card_token(
  p_card_id      uuid,
  p_token        text,
  p_brand        text,
  p_last_four    text,
  p_expiry_month int,
  p_expiry_year  int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_card       record;
  v_old_token  text;
  v_plan       record;
  v_count      int   := 0;
  v_refs       jsonb := '[]'::jsonb;
BEGIN
  -- Caller is saveCardForPatient running with the service-role client.
  -- No auth.uid() to check; the card-id parameter carries the patient
  -- context.
  SELECT id, patient_id, is_default, last_four, token
    INTO v_card
    FROM payment_methods
   WHERE id = p_card_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'card_not_found';
  END IF;

  v_old_token := v_card.token;

  -- Refresh the card row. is_default is NOT touched — that's owned by
  -- change_default_card.
  UPDATE payment_methods
     SET token        = p_token,
         card_brand   = p_brand,
         last_four    = p_last_four,
         expiry_month = p_expiry_month,
         expiry_year  = p_expiry_year,
         reusable     = true
   WHERE id = p_card_id;

  -- Repoint every plan whose CURRENT peach_registration_id equals the
  -- old token to the new one. Token-based scope (not patient-wide)
  -- prevents cross-plan overwrite when the patient holds two active
  -- plans on two physical cards.
  --
  -- Guard: if the old token is null (a freshly-vaulted card whose row
  -- never carried a token) or unchanged, there's nothing to repoint.
  IF v_old_token IS NOT NULL AND v_old_token IS DISTINCT FROM p_token THEN
    FOR v_plan IN
      UPDATE plans
         SET peach_registration_id = p_token
       WHERE patient_id = v_card.patient_id
         AND status IN ('active', 'pending_first_payment')
         AND peach_registration_id = v_old_token
      RETURNING id, invoice_number
    LOOP
      v_count := v_count + 1;
      v_refs  := v_refs || jsonb_build_array(
        jsonb_build_object(
          'id',              v_plan.id,
          'invoice_number',  v_plan.invoice_number
        )
      );

      INSERT INTO plan_events (plan_id, patient_id, event_type, payload)
        VALUES (
          v_plan.id,
          v_card.patient_id,
          'token_refreshed',
          jsonb_build_object(
            'last_four', p_last_four,
            'card_id',   p_card_id
          )
        );
    END LOOP;
  END IF;

  -- The is_default field is still returned in the payload so any
  -- caller that consumes it (currently none) continues to work.
  RETURN jsonb_build_object(
    'is_default',      v_card.is_default,
    'repointed_plans', v_count,
    'plan_refs',       v_refs
  );
END;
$$;

-- Grant unchanged — the RPC is called via the service-role client
-- inside saveCardForPatient's "update" branch.
GRANT EXECUTE ON FUNCTION refresh_card_token(uuid, text, text, text, int, int)
  TO service_role;

COMMENT ON FUNCTION refresh_card_token(uuid, text, text, text, int, int) IS
  'Card-token refresh + per-plan token repoint. Repoints ALL plans currently '
  'holding this card row''s OLD token to the new token — token-scoped to '
  'avoid cross-plan overwrite. Live column is plans.peach_registration_id '
  '(post-0076/0077 Peach swap). Called from saveCardForPatient''s dedupe '
  '''update'' branch.';
