-- Repoint change_default_card onto the Peach column — the sibling of the
-- 0078 refresh_card_token fix, which was missed.
--
-- The bug (audit P0 #1):
--
--   change_default_card (0039/0040) still writes plans.paystack_authorization_code
--   and scopes its WHERE by that same dead column (SET the dead column =
--   v_new.token; WHERE the dead column differs from v_new.token).
--
--   Post-0076/0077 the live token column every collection path reads is
--   plans.peach_registration_id (chargeInstalment.ts, payWithSavedCard,
--   settle-actions.ts, the Peach webhook, collect-instalments cron).
--   No live code reads paystack_authorization_code — the Peach save path
--   never writes it, so it is NULL for every Peach-era plan.
--
--   Two consequences:
--     1. "Change default card" / remove-default repointed a column
--        NOTHING reads → the cron kept charging the OLD registrationId
--        (the old card) after the patient explicitly switched cards.
--     2. Because the WHERE compared the always-NULL dead column against
--        the new token, the predicate was TRUE for every plan (NULL
--        differs from any token), so the function "repointed" ALL of the
--        patient's active/pending plans and returned a fabricated
--        repointed_plans count — the UI promised "N plans moved" while
--        zero were actually moved in the live column.
--
-- The fix (mirrors 0078 exactly):
--   • SET plans.peach_registration_id (the live column).
--   • TOKEN-SCOPED WHERE: repoint ONLY plans whose CURRENT
--     peach_registration_id equals the OLD default's token — NOT every
--     active/pending plan. A plan deliberately on a DIFFERENT physical
--     card is never clobbered. (0040 repointed patient-wide as a "self-
--     heal"; under Peach each plan holds its own per-CIT registrationId,
--     and refresh_card_token already handles genuine token drift, so the
--     correct scope here is old-card → new-card only.)
--   • repointed_plans is now TRUTHFUL — it counts only plans actually
--     moved from the old default card to the new one.
--   • Flag flip, plan_events audit row, return shape, SECURITY DEFINER +
--     search_path pin, and the GRANT are all unchanged.

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

  -- Repoint ONLY plans currently collecting from the OLD default card
  -- (peach_registration_id = the old token) onto the new default's token.
  -- Token-scoped so a plan on a THIRD, different card is never clobbered,
  -- and so the returned count is truthful. Guard: skip when there's no
  -- old token, no new token, or the two are the same.
  IF v_old.token IS NOT NULL
     AND v_new.token IS NOT NULL
     AND v_old.token IS DISTINCT FROM v_new.token THEN
    FOR v_plan IN
      UPDATE plans
         SET peach_registration_id = v_new.token
       WHERE patient_id = v_user_id
         AND status IN ('active', 'pending_first_payment')
         AND peach_registration_id = v_old.token
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
  END IF;

  RETURN jsonb_build_object(
    'changed',         true,
    'repointed_plans', v_count,
    'plan_refs',       v_refs,
    'old_last_four',   v_old.last_four,
    'new_last_four',   v_new.last_four
  );
END;
$$;

GRANT EXECUTE ON FUNCTION change_default_card(uuid) TO authenticated;

COMMENT ON FUNCTION change_default_card(uuid) IS
  'Promote a saved card to default + repoint the patient''s plans that '
  'currently collect from the OLD default card onto the new card''s token. '
  'Writes plans.peach_registration_id (the live column post-0076/0077); '
  'token-scoped (old-card → new-card only) so plans on a different card are '
  'never clobbered and repointed_plans is truthful. Supersedes the 0039/0040 '
  'version that wrote the dead plans.paystack_authorization_code.';
