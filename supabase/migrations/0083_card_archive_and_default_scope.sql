-- Card-management rules: default-for-new-plans + conditional soft-delete.
--
-- Two behaviour changes land together here (the code that depends on them
-- ships in the same PR):
--
--   RULE 1 — DEFAULT applies to NEW plans only.
--     The account "default card" is consumed at plan creation to seed a new
--     plan's collecting card. It must NOT re-point collection on any
--     existing/active plan. The old change_default_card (0079) repointed
--     active plans onto the new default; the new flag-only path
--     set_default_card_flag flips is_default and touches NO plan row.
--     (change_default_card is left in place, now unused by the patient card
--     surface, so historical/admin references don't break.)
--
--   RULE 2 — a card CANNOT be removed while it is collecting an active plan.
--     Removal is now a SOFT-DELETE (archive): we keep the processor token
--     for reconciliation/disputes and drop the card from the patient's
--     active list. archive_card enforces the guard IN THE DATABASE so a
--     direct client call cannot bypass a hidden/disabled UI button, and the
--     patient hard-DELETE RLS policy is removed so archive is the only path.

-- ── archived_at column (NULL = active) ───────────────────────────────────
ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN payment_methods.archived_at IS
  'Soft-delete marker. NULL = active/usable. When set, the card is retained '
  '(token kept for reconciliation/disputes) but excluded from the patient''s '
  'active card list. Only set via archive_card(), which blocks archiving a '
  'card that is currently collecting an active plan.';

-- Active-card lookups (the common case) skip archived rows.
CREATE INDEX IF NOT EXISTS payment_methods_patient_active_idx
  ON payment_methods (patient_id)
  WHERE archived_at IS NULL;

-- ── RULE 1: flag-only default (no plan repoint) ──────────────────────────
CREATE OR REPLACE FUNCTION set_default_card_flag(p_card_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_new     record;
  v_old     record;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT id, is_default, last_four
    INTO v_new
    FROM payment_methods
   WHERE id = p_card_id
     AND patient_id = v_user_id
     AND archived_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'card_not_found';
  END IF;

  IF v_new.is_default THEN
    RETURN jsonb_build_object(
      'changed',       false,
      'old_last_four', v_new.last_four,
      'new_last_four', v_new.last_four
    );
  END IF;

  SELECT last_four INTO v_old
    FROM payment_methods
   WHERE patient_id = v_user_id
     AND is_default = true
     FOR UPDATE;

  -- Flag flip ONLY. No plans row is touched: existing plans keep the card
  -- they were created with (RULE 1 — default is for NEW plans only).
  UPDATE payment_methods
     SET is_default = false
   WHERE patient_id = v_user_id
     AND is_default = true;

  UPDATE payment_methods
     SET is_default = true
   WHERE id = p_card_id
     AND patient_id = v_user_id;

  RETURN jsonb_build_object(
    'changed',       true,
    'old_last_four', v_old.last_four,
    'new_last_four', v_new.last_four
  );
END;
$$;

GRANT EXECUTE ON FUNCTION set_default_card_flag(uuid) TO authenticated;

COMMENT ON FUNCTION set_default_card_flag(uuid) IS
  'Promote a saved card to the account default by flipping is_default only. '
  'Deliberately does NOT repoint any plan (default applies to NEW plans); '
  'existing plans keep their own peach_registration_id, changeable per-plan.';

-- ── RULE 2: conditional soft-delete (archive) with a DB-enforced guard ───
CREATE OR REPLACE FUNCTION archive_card(p_card_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id       uuid;
  v_card          record;
  v_collecting    int;
  v_promoted_id   uuid := NULL;
  v_promoted_last text := NULL;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT id, token, is_default, archived_at
    INTO v_card
    FROM payment_methods
   WHERE id = p_card_id
     AND patient_id = v_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'card_not_found';
  END IF;

  -- Idempotent: archiving an already-archived card is a no-op success.
  IF v_card.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('archived', true, 'promoted_default_id', NULL, 'promoted_last_four', NULL);
  END IF;

  -- GUARD (the whole point): block while this card backs an active plan.
  -- "Active" = a plan still collecting instalments (active or awaiting its
  -- first charge). Completed/cancelled/declined/defaulted plans never block.
  SELECT count(*) INTO v_collecting
    FROM plans
   WHERE patient_id = v_user_id
     AND status IN ('active', 'pending_first_payment')
     AND peach_registration_id = v_card.token;

  IF v_collecting > 0 THEN
    RAISE EXCEPTION 'card_collecting_active_plan';
  END IF;

  -- Soft-delete: keep the row + token, drop it from the active list.
  UPDATE payment_methods
     SET archived_at = now(),
         is_default  = false   -- an archived card is never the default
   WHERE id = p_card_id
     AND patient_id = v_user_id;

  -- If it was the default, promote the newest OTHER active card so a sane
  -- default always exists (when one is available).
  IF v_card.is_default THEN
    SELECT id, last_four
      INTO v_promoted_id, v_promoted_last
      FROM payment_methods
     WHERE patient_id = v_user_id
       AND archived_at IS NULL
       AND id <> p_card_id
     ORDER BY created_at DESC
     LIMIT 1;

    IF v_promoted_id IS NOT NULL THEN
      UPDATE payment_methods
         SET is_default = true
       WHERE id = v_promoted_id
         AND patient_id = v_user_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'archived',            true,
    'promoted_default_id', v_promoted_id,
    'promoted_last_four',  v_promoted_last
  );
END;
$$;

GRANT EXECUTE ON FUNCTION archive_card(uuid) TO authenticated;

COMMENT ON FUNCTION archive_card(uuid) IS
  'Soft-delete a saved card: blocks (card_collecting_active_plan) while the '
  'card''s token backs any active/pending_first_payment plan; otherwise sets '
  'archived_at, clears the default flag, and promotes the newest other active '
  'card to default. Retains the token for reconciliation/disputes.';

-- ── Close BOTH direct-mutation bypasses (DELETE and UPDATE) ──────────────
-- The rules are only real if a patient can't sidestep the SECURITY DEFINER
-- functions with a direct client write:
--
--   • DELETE — a direct delete would skip archive_card's active-plan guard.
--   • UPDATE — Postgres RLS can't column-scope a policy, so a row-level
--     patient UPDATE policy would let a patient set is_default or
--     archived_at by hand, bypassing set_default_card_flag / archive_card
--     (re-opening exactly the default-scoping RULE 1 just closed, and
--     letting a card be "archived" while still backing an active plan).
--
-- No app path does a direct patient UPDATE/DELETE on payment_methods: every
-- mutation goes through a SECURITY DEFINER function (set_default_card_flag,
-- archive_card, refresh_card_token, change_default_card) or the service-role
-- webhook (which bypasses RLS). So patients keep only INSERT + SELECT; all
-- state changes to is_default / archived_at flow through the guarded RPCs.
DROP POLICY IF EXISTS patients_delete_own_payment_methods ON payment_methods;
DROP POLICY IF EXISTS patients_update_own_payment_methods ON payment_methods;
