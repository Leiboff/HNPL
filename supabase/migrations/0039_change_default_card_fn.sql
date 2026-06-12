-- Atomic helper that promotes a card to default AND repoints every
-- active / pending-first-payment plan currently collecting from the
-- previous default. All side effects happen inside one function-scoped
-- transaction — any failure rolls back BOTH the default flag flip and
-- the plan repoint, preserving the invariant
--   "active plans always collect from the patient's default card".
--
-- Side effects when changing default from old → new card:
--   1. is_default: old card → false, new card → true
--   2. plans where status IN ('active','pending_first_payment') AND
--      paystack_authorization_code = old.token are updated to new.token
--   3. one plan_events('collection_card_changed') row per repointed plan
--
-- Returns jsonb { changed, repointed_plans, plan_refs, old_last_four,
-- new_last_four }. If the target is already the default, returns
-- changed=false with no side effects.

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

  -- Load the target card. Must belong to the caller.
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
    -- Already default; nothing to do.
    RETURN jsonb_build_object(
      'changed',          false,
      'repointed_plans',  0,
      'plan_refs',        '[]'::jsonb,
      'old_last_four',    v_new.last_four,
      'new_last_four',    v_new.last_four
    );
  END IF;

  -- Latch the current default (may be NULL if the invariant is broken).
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

  -- Repoint any active / pending-first-payment plans that still point
  -- at the previous default's token, and write a plan_events row for
  -- each. If there was no previous default we don't repoint anything —
  -- those plans must be backfilled separately.
  IF v_old.token IS NOT NULL THEN
    FOR v_plan IN
      UPDATE plans
         SET paystack_authorization_code = v_new.token
       WHERE patient_id = v_user_id
         AND status IN ('active', 'pending_first_payment')
         AND paystack_authorization_code = v_old.token
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
            'from_last_four', v_old.last_four,
            'to_last_four',   v_new.last_four
          )
        );
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'changed',          true,
    'repointed_plans',  v_count,
    'plan_refs',        v_refs,
    'old_last_four',    v_old.last_four,
    'new_last_four',    v_new.last_four
  );
END;
$$;

GRANT EXECUTE ON FUNCTION change_default_card(uuid) TO authenticated;
