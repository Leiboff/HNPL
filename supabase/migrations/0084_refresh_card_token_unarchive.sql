-- refresh_card_token resurrects a re-vaulted card that was removed (archived).
--
-- Bug: migration 0083 added payment_methods.archived_at (soft-delete on
-- "Remove card"), but the re-vault path never learned about it. When a
-- patient re-adds a card they had removed, saveCardForPatient's fingerprint
-- dedup finds the archived row (its query does NOT filter archived_at), sees
-- a NEW registrationId (Peach mints a fresh one per registration), and takes
-- the 'update' branch → refresh_card_token. The 0078 body refreshed
-- token/brand/last_four/expiry but left archived_at SET, so the flow reported
-- "Card added successfully" while the row stayed archived — and the account
-- list (which filters archived_at IS NULL) kept hiding it. Adding a card
-- added nothing the patient could see.
--
-- Fix (this migration):
--   1. RESURRECT on re-vault — clear archived_at in the payment_methods
--      UPDATE. Re-adding a removed card is a deliberate "I want this card
--      back". Harmless no-op for an ordinary same-card refresh, where
--      archived_at is already NULL.
--   2. SANE DEFAULT — if the patient now has no default among their ACTIVE
--      cards (e.g. this resurrected card was their only one, de-defaulted
--      when it was archived by 0083's archive_card), promote it so plan
--      creation still has a default to seed from. Never steals the default
--      from an existing active default card.
--
-- Everything else is unchanged from 0078: the token-scoped per-plan repoint,
-- the null-old-token guard, and the cross-plan / cross-patient safety.
-- SECURITY DEFINER + search_path pin + service_role grant all preserved.

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

  -- Refresh the card row. Re-vaulting RESURRECTS a removed (archived) card
  -- by clearing archived_at, so the account list shows it again. is_default
  -- is not touched here (owned by the default RPCs) beyond the sane-default
  -- backfill below.
  UPDATE payment_methods
     SET token        = p_token,
         card_brand   = p_brand,
         last_four    = p_last_four,
         expiry_month = p_expiry_month,
         expiry_year  = p_expiry_year,
         reusable     = true,
         archived_at  = NULL
   WHERE id = p_card_id;

  -- Sane default: if no ACTIVE card is the patient's default (this
  -- resurrected card was their only one, de-defaulted when archived),
  -- promote it. Guarded by NOT EXISTS so an existing active default is
  -- never overridden.
  IF NOT EXISTS (
    SELECT 1
      FROM payment_methods
     WHERE patient_id  = v_card.patient_id
       AND archived_at IS NULL
       AND is_default  = true
  ) THEN
    UPDATE payment_methods
       SET is_default = true
     WHERE id = p_card_id;
  END IF;

  -- Repoint every plan whose CURRENT peach_registration_id equals the old
  -- token to the new one. Token-based scope (not patient-wide) prevents
  -- cross-plan overwrite when the patient holds two active plans on two
  -- physical cards. Guard: null / unchanged old token → nothing to repoint.
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

  -- is_default in the payload is the PRE-backfill value (unchanged from
  -- 0078). No caller consumes it; the row's own is_default is authoritative.
  RETURN jsonb_build_object(
    'is_default',      v_card.is_default,
    'repointed_plans', v_count,
    'plan_refs',       v_refs
  );
END;
$$;

-- Grant unchanged — the RPC is called via the service-role client inside
-- saveCardForPatient's dedupe 'update' branch.
GRANT EXECUTE ON FUNCTION refresh_card_token(uuid, text, text, text, int, int)
  TO service_role;

COMMENT ON FUNCTION refresh_card_token(uuid, text, text, text, int, int) IS
  'Card-token refresh + per-plan token repoint (0078), plus: RESURRECTS a '
  're-vaulted archived card (clears archived_at) and backfills the default '
  'when no active default exists. Repoints ALL active/pending plans holding '
  'this row''s OLD token to the new token (token-scoped). Called from '
  'saveCardForPatient''s dedupe ''update'' branch via the service-role client.';
