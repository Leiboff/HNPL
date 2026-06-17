-- ─── Bill lifecycle: viewed_at signal + realtime publication ─────────────
--
-- BACKGROUND
--   Providers can't tell whether a patient has opened the checkout link
--   the practice emailed them. That gap matters in two contexts:
--
--     • AT-THE-TILL — the receptionist needs the "card machine beep" of
--       seeing payment land before they release the patient.
--     • SENT-HOME    — the practice checks back later; "Viewed" vs
--       "Sent" is the difference between "they got it, they're working
--       on it" and "email never arrived — try again".
--
--   The bill status lifecycle (Sent / Viewed / Paid / Expired) is
--   derived from three pieces of state we already track plus ONE new
--   one: when the patient first opened /checkout/[token].
--
-- WHAT THIS MIGRATION DOES
--   1. Adds patient_invitations.viewed_at  TIMESTAMPTZ (nullable).
--   2. Adds SECURITY DEFINER RPC stamp_invitation_viewed(p_token) that
--      writes viewed_at = now() exactly once per invitation. Idempotent
--      by construction (WHERE viewed_at IS NULL). Anon-callable so the
--      anonymous checkout page can fire it before the patient signs in.
--   3. Adds patient_invitations + plans to the Supabase realtime
--      publication so the practice's "watching for payment" panel can
--      subscribe to both signals (viewed_at flip and plan→active).
--
--   No existing policy or RPC is altered — get_invitation_by_token
--   (migration 0049) keeps working unchanged.

-- 1. New column. Nullable: a row gets stamped the first time the
--    patient opens the link; NULL means "never opened" which the
--    lifecycle helper renders as "Sent".
ALTER TABLE patient_invitations
  ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ;

-- 2. Exact-token stamp. Returns void; the caller fires this fire-and-
--    forget on /checkout/[token] load. Idempotent — the WHERE clause
--    naturally skips already-stamped rows.
--
--    Notes:
--      • viewed_at IS NULL guards against re-stamps on every page load.
--      • expires_at > now()       prevents resurrecting dead invitations.
--      • We deliberately do NOT gate on accepted_at — a returning
--        patient who already paid would just see their first-open
--        time, which is still the right answer.
--      • SECURITY DEFINER + SET search_path = public defends against
--        the caller-controlled search_path attack pattern.
CREATE OR REPLACE FUNCTION stamp_invitation_viewed(p_token TEXT)
RETURNS VOID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE patient_invitations
     SET viewed_at = now()
   WHERE token       = p_token
     AND viewed_at IS NULL
     AND expires_at  > now();
$$;

GRANT EXECUTE ON FUNCTION stamp_invitation_viewed(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION stamp_invitation_viewed(TEXT) IS
  'Fire-and-forget stamp of patient_invitations.viewed_at on the first '
  'load of /checkout/[token]. Idempotent (no-op once stamped, no-op '
  'after expiry). Anon-callable: the patient is unauthenticated at '
  'that point. Failure is non-fatal to the patient flow — the caller '
  'must swallow errors so a transient stamp failure never blocks '
  'checkout.';

-- 3. Realtime publication. Wrapped in DO blocks so re-running this
--    migration on an environment where one (or both) tables are already
--    members of the publication is a no-op.
--
--    The practice "waiting for payment" screen subscribes to:
--      • patient_invitations  (viewed_at NULL → timestamp signal)
--      • plans                (status pending_first_payment → active)
--    Both are needed to drive the live transition Sent → Viewed → Paid.
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE patient_invitations;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE plans;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
