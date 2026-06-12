-- Close the remaining token-drift window: the saveCardForPatient
-- "updated" branch (Paystack reissued an authorization_code for a card
-- whose signature is already on file) must propagate the new token to
-- any active / pending-first-payment plan that's collecting from this
-- card, in the same transaction as the payment_methods UPDATE.
--
-- Make-default's change_default_card RPC is the backstop. This RPC is
-- the primary defence — drift can never persist past the moment a token
-- is refreshed.

-- ─── plan_events.event_type — allow the new 'token_refreshed' value ──────────

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
    FROM pg_constraint
   WHERE conrelid = 'plan_events'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%event_type%';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE plan_events DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END;
$$;

ALTER TABLE plan_events
  ADD CONSTRAINT plan_events_event_type_check
  CHECK (event_type IN ('collection_card_changed', 'token_refreshed'));

-- ─── refresh_card_token RPC ─────────────────────────────────────────────────

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
  v_card   record;
  v_plan   record;
  v_count  int   := 0;
  v_refs   jsonb := '[]'::jsonb;
BEGIN
  -- Caller is saveCardForPatient running with the service-role client
  -- (webhook or callback verify path). No auth.uid() to check; the
  -- card-id parameter carries the patient context.
  SELECT id, patient_id, is_default, last_four
    INTO v_card
    FROM payment_methods
   WHERE id = p_card_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'card_not_found';
  END IF;

  -- Refresh the card row. Do NOT touch is_default — that's owned by
  -- change_default_card.
  UPDATE payment_methods
     SET token        = p_token,
         card_brand   = p_brand,
         last_four    = p_last_four,
         expiry_month = p_expiry_month,
         expiry_year  = p_expiry_year,
         reusable     = true
   WHERE id = p_card_id;

  -- If this is the patient's default card, propagate the new token to
  -- every active / pending plan whose stored token isn't already the new
  -- value. Same IS DISTINCT FROM predicate as change_default_card so the
  -- two enforcement paths can never disagree.
  IF v_card.is_default THEN
    FOR v_plan IN
      UPDATE plans
         SET paystack_authorization_code = p_token
       WHERE patient_id = v_card.patient_id
         AND status IN ('active', 'pending_first_payment')
         AND paystack_authorization_code IS DISTINCT FROM p_token
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

  RETURN jsonb_build_object(
    'is_default',      v_card.is_default,
    'repointed_plans', v_count,
    'plan_refs',       v_refs
  );
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_card_token(uuid, text, text, text, int, int)
  TO service_role;
