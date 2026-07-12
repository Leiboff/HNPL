-- ─── CRM conversion — hardening pass ────────────────────────────────
--
-- Two defects in the accept-invitation + auto-onboarded pipeline from
-- 0068/0069, both non-obvious enough to survive review of the initial
-- commit. This migration fixes both.
--
--   1. accept_practice_invitation was SECURITY DEFINER + pinned
--      search_path (good) BUT accepted an arbitrary p_practice_id
--      without verifying the calling user owned it. A leaked token
--      (Slack forward, screenshot, etc.) combined with a known
--      practice_id would let one user attach that invite to another
--      user's practice — bypass of the intended "invited practice
--      redeems its own invite" model.
--
--      The signup flow calls this RPC via the service-role client
--      (auth.role() = 'service_role') because the freshly-created
--      practice_admin has no session yet — email verification hasn't
--      happened. The service-role path is trusted end-to-end and
--      MUST continue to work; the ownership check applies only to
--      authenticated non-service callers.
--
--   2. crm_flip_lead_onboarded_on_practice_approve ran inside the
--      practice-approval transaction with no exception guard. Any
--      failure inside the CRM UPDATE (constraint, cascading trigger
--      error, etc.) would abort the approval — approval must NOT be
--      blockable by CRM state. Wrap the flip in a BEGIN/EXCEPTION
--      block that swallows the error via RAISE WARNING and returns
--      NEW so approval proceeds.
--
-- Additive: no changes to any table, RLS policy, or column. Only the
-- two functions are redefined.

-- ── 1. accept_practice_invitation — ownership check + service-role bypass

CREATE OR REPLACE FUNCTION accept_practice_invitation(
  p_token       TEXT,
  p_practice_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead_id  UUID;
  v_is_svc   BOOLEAN;
  v_owns     BOOLEAN;
BEGIN
  v_is_svc := (auth.role() = 'service_role');

  -- Non-service callers must own the target practice (either as
  -- practices.owner_id or as an active row in practice_members). Service
  -- callers (the signup action) are exempt — they're inserting the
  -- practice AND immediately calling this RPC in the same request, so
  -- there is no separate "caller" identity to validate.
  IF NOT v_is_svc THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'accept_practice_invitation: not authenticated'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM practices
       WHERE id = p_practice_id
         AND owner_id = auth.uid()
      UNION ALL
      SELECT 1
        FROM practice_members
       WHERE practice_id = p_practice_id
         AND user_id     = auth.uid()
         AND active
    ) INTO v_owns;

    IF NOT v_owns THEN
      RAISE EXCEPTION 'accept_practice_invitation: caller does not own the target practice'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Token validity is enforced by the WHERE clause. If no invitation
  -- row matches (unknown / expired / already accepted), the UPDATE
  -- affects zero rows and v_lead_id stays NULL — no state change.
  UPDATE practice_invitations
     SET accepted_at             = now(),
         accepted_by_practice_id = p_practice_id
   WHERE token         = p_token
     AND accepted_at   IS NULL
     AND expires_at    > now()
  RETURNING lead_id INTO v_lead_id;

  -- Idempotent lead-stamp. converted_practice_id is set once; a
  -- re-invocation with the same token is a no-op because accepted_at
  -- is now non-null (blocking the UPDATE above) and, defensively,
  -- because the WHERE clause below only touches unstamped leads.
  IF v_lead_id IS NOT NULL THEN
    UPDATE crm_leads
       SET converted_practice_id = p_practice_id
     WHERE id = v_lead_id
       AND converted_practice_id IS NULL;
  END IF;

  RETURN v_lead_id;
END;
$$;

COMMENT ON FUNCTION accept_practice_invitation(TEXT, UUID) IS
  'Redemption RPC for /signup/practice?token=…. SECURITY DEFINER + '
  'pinned search_path. Ownership check: non-service callers must own '
  'p_practice_id (via practices.owner_id OR active practice_members '
  'row). Service-role callers (the signup flow) bypass the ownership '
  'check because they''re creating the practice + redeeming in one '
  'atomic request. Idempotent on repeat calls.';

-- ── 2. crm_flip_lead_onboarded_on_practice_approve — exception guard ──

CREATE OR REPLACE FUNCTION crm_flip_lead_onboarded_on_practice_approve()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only fire on the pending → approved transition. Re-approvals and
  -- non-status updates are silent no-ops (the AFTER UPDATE OF status
  -- trigger clause already narrows this, but the runtime check
  -- protects against a future trigger definition change).
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    BEGIN
      UPDATE crm_leads AS l
         SET stage = 'onboarded'
        FROM practice_invitations AS pi
       WHERE pi.accepted_by_practice_id = NEW.id
         AND pi.lead_id                 = l.id
         AND l.stage IN ('signed', 'agreement_sent');
    EXCEPTION WHEN OTHERS THEN
      -- CRM state must NEVER block a practice approval. Downgrade any
      -- unexpected failure to a warning so the approval transaction
      -- proceeds; the operator will see the warning in the DB log and
      -- can hand-flip the lead if it matters.
      RAISE WARNING
        'crm_flip_lead_onboarded_on_practice_approve failed for practice %: %',
        NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION crm_flip_lead_onboarded_on_practice_approve() IS
  'AFTER UPDATE OF status trigger. Flips crm_leads.stage signed → '
  'onboarded when the practice is approved. Wrapped in an exception '
  'block so any CRM-side failure downgrades to WARNING instead of '
  'aborting the approval transaction — approval MUST NOT be blockable '
  'by CRM state.';
