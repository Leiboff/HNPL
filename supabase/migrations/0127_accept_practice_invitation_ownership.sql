-- ─── accept_practice_invitation checks who owns the practice it links ───
--
-- THE DEFECT (audit 2026-09-02, A-07)
--
-- The RPC writes `p_practice_id` verbatim:
--
--     UPDATE practice_invitations
--        SET accepted_at = now(), accepted_by_practice_id = p_practice_id
--      WHERE token = p_token AND accepted_at IS NULL AND expires_at > now()
--
-- Nothing checked that the caller owns or is a member of that practice, and
-- 0068 granted it to `authenticated`. So anyone holding a live practice
-- invitation token — the invited practitioner, or anyone who received a
-- forwarded signup email — could burn the token (`accepted_at` set, so the
-- genuine practitioner's link stops working) and point the linked CRM lead's
-- `converted_practice_id` at a practice of their choosing. Sales attribution
-- and the account's billing view (`crm_accounts_billing_summary`,
-- `crm_flip_lead_onboarded_on_practice_approve`) follow that column.
--
-- Single-use and scoped to one lead, so this was never a mass-assignment
-- vector. It was a denial of a partner's onboarding plus corruption of the
-- sales record.
--
-- 0068's header explains the missing check as a consequence of the design:
-- "Uses the app.privileged_write bypass so the update proceeds even when the
-- caller is the newly-created practice-admin session (which has no read
-- access to the row via the RLS policies above)". The read problem is real.
-- Solving it by removing the authorisation, rather than by moving the read
-- inside a definer function that still authorises, is what left the hole.
-- (The bypass that sentence describes was never actually written, either —
-- there is no set_config in the function.)
--
-- ─── THE FIX ───────────────────────────────────────────────────────────
--
-- Two layers, and 0125 already added a third by revoking `authenticated`.
--
--   1. A privileged caller passes. After 0125 that is the only caller: the
--      sole call site is app/signup/practice/actions.ts, on the service-role
--      client, and it passes a practiceId the same action inserted moments
--      earlier with owner_id = the signing-up user — so ownership holds by
--      construction there.
--   2. Anyone else must own the practice or hold an active membership on it.
--
-- Returns NULL on refusal, which is what an already-accepted, expired or
-- unknown token already returns. A caller cannot tell which of those
-- happened, so probing practice ids learns nothing.
--
-- Idempotency is unchanged: a second call for an accepted token still
-- returns NULL, so the signup flow can still retry safely.

-- DEPENDS ON 0126, which repaired hnpl_write_is_privileged() to return
-- false rather than NULL. The guard below is written `IS NOT TRUE` so it is
-- correct either way, but the ordering is worth knowing.

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
  v_lead_id UUID;
BEGIN
  -- ── Ownership gate (0127, audit A-07) ────────────────────────────────
  IF hnpl_write_is_privileged() IS NOT TRUE THEN
    IF auth.uid() IS NULL THEN
      RETURN NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM practices
       WHERE id = p_practice_id AND owner_id = auth.uid()
    ) AND NOT EXISTS (
      SELECT 1 FROM practice_members
       WHERE practice_id = p_practice_id
         AND user_id     = auth.uid()
         AND active
    ) THEN
      RETURN NULL;
    END IF;
  END IF;

  UPDATE practice_invitations
     SET accepted_at             = now(),
         accepted_by_practice_id = p_practice_id
   WHERE token         = p_token
     AND accepted_at   IS NULL
     AND expires_at    > now()
  RETURNING lead_id INTO v_lead_id;

  RETURN v_lead_id;  -- NULL if the token was already accepted / expired / unknown
END;
$$;

COMMENT ON FUNCTION accept_practice_invitation(TEXT, UUID) IS
  'Atomically stamps accepted_at + accepted_by_practice_id on the invite row '
  'matching the token, and returns lead_id so callers can link the CRM lead. '
  'As of 0127 a non-privileged caller must own p_practice_id or hold an '
  'active membership on it (audit A-07); refusal returns NULL, which is '
  'indistinguishable from an already-accepted or unknown token. Idempotent.';

-- Grant unchanged: 0125 left this service_role-only, and CREATE OR REPLACE
-- preserves that.
