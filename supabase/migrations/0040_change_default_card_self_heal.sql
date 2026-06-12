-- Self-healing change_default_card.
--
-- Migration 0038 only repointed plans whose paystack_authorization_code
-- exactly matched the PREVIOUS default's token. Token drift caused by
-- earlier testing or by saveCardForPatient's token-refresh path left
-- some active plans pointing at orphaned tokens (no payment_methods row
-- exists for them anymore). Those plans were silently skipped on every
-- make-default click — N=0 in the preview, zero rows updated, no
-- plan_events written, and the invariant "active plans collect from the
-- default card" stayed broken.
--
-- This version repoints EVERY active / pending-first-payment plan whose
-- token is not already the new default's. Any token drift is corrected
-- the next time the patient changes their default. The function is
-- still fully transactional — any failure rolls back the flag flip,
-- the plan UPDATE, AND the plan_events insert.

CREATE OR REPLACE FUNCTION change_default_card(p_card_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id  uuid;
  v_new      record;
  v_old      record;
  v_plan     record;
  v_count    int   := 0;
  v_refs     jsonb := '[]'::jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT id, token, is_default, last_four
    INTO v_new
    FROM payment_methods
   WHERE id = p_card_id
     AND patient_id = v_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'card_not_found';
  END IF;

  IF v_new.is_default THEN
    RETURN jsonb_build_object(
      'changed',          false,
      'repointed_plans',  0,
      'plan_refs',        '[]'::jsonb,
      'old_last_four',    v_new.last_four,
      'new_last_four',    v_new.last_four
    );
  END IF;

  -- Latch the current default (may be NULL only in pre-invariant data).
  SELECT id, token, last_four
    INTO v_old
    FROM payment_methods
   WHERE patient_id = v_user_id
     AND is_default = true
     FOR UPDATE;

  -- Flip the flags.
  UPDATE payment_methods
     SET is_default = false
   WHERE patient_id = v_user_id
     AND is_default = true;

  UPDATE payment_methods
     SET is_default = true
   WHERE id = p_card_id
     AND patient_id = v_user_id;

  -- Repoint every active / pending plan that isn't already on the new
  -- default's token. Self-heals any prior drift. The plan_events
  -- "from_last_four" uses the previous default's last_four when one
  -- existed; for orphaned-token plans we record 'unknown' so the audit
  -- trail still captures the change.
  FOR v_plan IN
    UPDATE plans
       SET paystack_authorization_code = v_new.token
     WHERE patient_id = v_user_id
       AND status IN ('active', 'pending_first_payment')
       AND paystack_authorization_code IS DISTINCT FROM v_new.token
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
        v_user_id,
        'collection_card_changed',
        jsonb_build_object(
          'from_last_four', COALESCE(v_old.last_four, 'unknown'),
          'to_last_four',   v_new.last_four
        )
      );
  END LOOP;

  RETURN jsonb_build_object(
    'changed',         true,
    'repointed_plans', v_count,
    'plan_refs',       v_refs,
    'old_last_four',   v_old.last_four,
    'new_last_four',   v_new.last_four
  );
END;
$$;

-- The 0038 GRANT carries through; restating defensively in case this
-- migration is applied to a database that's missing the privilege.
GRANT EXECUTE ON FUNCTION change_default_card(uuid) TO authenticated;
