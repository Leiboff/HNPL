-- ─── Lock down patient_invitations PII surface ─────────────────────────────
--
-- BACKGROUND
--   Migration 0021 added a `public_token_lookup` policy on
--   patient_invitations with `USING (true)` — intended to let the
--   anonymous checkout landing page fetch one invitation by its
--   32-byte token. The comment justified it as "the token is
--   computationally infeasible to guess".
--
--   That defense is true for GUESSING but irrelevant for BULK READ.
--   Supabase's PostgREST exposes a row endpoint per table; with
--   `USING (true)` and the anon role's default SELECT grant, any
--   caller with the anon key — which is shipped in the client bundle
--   — could issue `GET /rest/v1/patient_invitations?select=*` and
--   dump every row: patient emails, practice_id, provider_id, the
--   tokens, the timestamps. For a POPIA / healthcare product that's
--   reportable PII exposure.
--
-- FIX
--   1. Drop the wide-open SELECT policy. The practice_admin SELECT
--      policy from 0021 stays, so practice admins continue to see
--      their own practice's invitations through the app.
--   2. Add a SECURITY DEFINER function get_invitation_by_token(p_token)
--      that returns a SINGLE invitation row — joined to its plan and
--      practice — only if the invitation is non-expired AND
--      unaccepted AND its plan is in a still-acceptable status.
--   3. Grant EXECUTE on that function to anon + authenticated. Anon
--      callers can ONLY resolve a token they already know; bulk
--      enumeration is impossible.
--
--   The function deliberately returns nothing for accepted / expired
--   / cancelled invitations. The page collapses all of those into a
--   single "this link is no longer valid" message — minor UX
--   downgrade in exchange for closing the bulk-dump vector.
--
--   `SET search_path = public` defends against the classic
--   SECURITY DEFINER search_path attack (caller-controlled schema
--   shadowing the tables the function references).

-- 1. Drop the wide-open policy.
DROP POLICY IF EXISTS "public_token_lookup" ON patient_invitations;

-- 2. Exact-token lookup function. Returns the row a caller needs to
--    render the checkout page; never a list, never a row for an
--    accepted / expired invitation.
CREATE OR REPLACE FUNCTION get_invitation_by_token(p_token TEXT)
RETURNS TABLE (
  email                TEXT,
  practice_name        TEXT,
  plan_id              UUID,
  plan_total_amount    NUMERIC,
  invoice_number       TEXT,
  practice_reference   TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pi.email,
    p.name              AS practice_name,
    pl.id               AS plan_id,
    pl.total_amount     AS plan_total_amount,
    pl.invoice_number,
    pl.practice_reference
  FROM patient_invitations pi
  JOIN plans     pl ON pl.id = pi.plan_id
  JOIN practices p  ON p.id  = pi.practice_id
  WHERE pi.token = p_token
    AND pi.accepted_at IS NULL
    AND pi.expires_at  > now()
    AND pl.status NOT IN ('completed', 'cancelled', 'declined')
  LIMIT 1;
$$;

-- 3. Grant EXECUTE to both anon (unauthenticated checkout visitor)
--    and authenticated (a logged-in patient revisiting a stale link).
GRANT EXECUTE ON FUNCTION get_invitation_by_token(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION get_invitation_by_token(TEXT) IS
  'Exact-token lookup for the anonymous /checkout/[token] page. '
  'Returns a single row for an invitation that is non-expired AND '
  'unaccepted AND whose plan is still acceptable; empty otherwise. '
  'Replaces the wide-open public_token_lookup SELECT policy from 0021.';
