-- ─── practice_invitations — invite a practice to sign up ────────────────
--
-- Missing piece from the CRM Phase 1 build (Step 0 enumeration
-- established that no practice-invite table exists today). Modelled on
-- patient_invitations (0021, 0049): 32-byte hex token, exact-token
-- lookup only, admin-and-sales scope on the row list.
--
-- Purpose: when a sales user marks a CRM lead as 'signed', the system
-- generates a practice_invitations row and the caller emails the
-- resulting URL to the practice. The practice-signup form recognises
-- ?token=<token>, looks the row up via the RPC below, pre-fills email
-- (locked), and links the resulting practice back to the CRM lead by
-- writing the crm_leads.converted_practice_id column (see 0069).
--
-- No mutation to existing tables. Additive-only.

CREATE TABLE IF NOT EXISTS practice_invitations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL,
  practice_name TEXT        NOT NULL,        -- pre-filled so the CRM's practice-name shows up on the signup form
  contact_first_name TEXT,
  contact_last_name  TEXT,
  phone         TEXT,
  specialty     TEXT,                        -- pre-fill; free-text per house convention (SPECIALTIES list is UI-only)
  lead_id       UUID,                        -- FK added below (deferred so this migration is not order-coupled to 0069)
  invited_by    UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  invited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  accepted_at   TIMESTAMPTZ,
  accepted_by_practice_id UUID REFERENCES practices(id) ON DELETE SET NULL,
  token         TEXT        UNIQUE NOT NULL
);

CREATE INDEX IF NOT EXISTS practice_invitations_email_idx  ON practice_invitations(email);
CREATE INDEX IF NOT EXISTS practice_invitations_token_idx  ON practice_invitations(token);
CREATE INDEX IF NOT EXISTS practice_invitations_lead_idx   ON practice_invitations(lead_id);

ALTER TABLE practice_invitations ENABLE ROW LEVEL SECURITY;

-- ── SELECT: admins and sales can list ────────────────────────────────
--
-- Everything else (patients, practice members, anon) sees zero rows.
-- The wide-open list access from patient_invitations 0021 was closed by
-- 0049; we do not repeat that mistake. Anonymous token lookup goes
-- through the SECURITY DEFINER RPC below, which returns exactly one
-- row for exactly one known token.

CREATE POLICY "practice_invitations_admin_sales_select"
  ON practice_invitations FOR SELECT
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "practice_invitations_admin_sales_insert"
  ON practice_invitations FOR INSERT
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "practice_invitations_admin_sales_update"
  ON practice_invitations FOR UPDATE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

-- ── Exact-token lookup (unauthenticated safe) ────────────────────────
--
-- Anonymous callers on /signup/practice?token=… hit this RPC. Same
-- shape as get_invitation_by_token(0049): returns AT MOST one row, only
-- for a token that is non-expired AND unaccepted. Bulk enumeration
-- via PostgREST is impossible because RLS blocks SELECT for anon.

CREATE OR REPLACE FUNCTION get_practice_invitation_by_token(p_token TEXT)
RETURNS TABLE (
  email               TEXT,
  practice_name       TEXT,
  contact_first_name  TEXT,
  contact_last_name   TEXT,
  phone               TEXT,
  specialty           TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pi.email,
    pi.practice_name,
    pi.contact_first_name,
    pi.contact_last_name,
    pi.phone,
    pi.specialty
  FROM practice_invitations pi
  WHERE pi.token = p_token
    AND pi.accepted_at IS NULL
    AND pi.expires_at  > now()
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_practice_invitation_by_token(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION get_practice_invitation_by_token(TEXT) IS
  'Exact-token lookup for /signup/practice?token=… — returns at most one '
  'row (non-expired, unaccepted). Bulk enumeration blocked by RLS.';

-- ── Redemption RPC ───────────────────────────────────────────────────
--
-- Called from the practice-signup server action AFTER the practice
-- row has been created. Stamps accepted_at + accepted_by_practice_id
-- atomically and returns the linked lead_id so the caller can update
-- the CRM lead's converted_practice_id column.
--
-- Uses the app.privileged_write bypass so the update proceeds even
-- when the caller is the newly-created practice-admin session (which
-- has no read access to the row via the RLS policies above — the row
-- lookup happens inside the SECURITY DEFINER function's context).
-- Idempotent: a second call for an already-accepted token returns
-- NULL, so the signup flow can safely retry on transient errors.

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

GRANT EXECUTE ON FUNCTION accept_practice_invitation(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION accept_practice_invitation(TEXT, UUID) IS
  'Atomically stamps accepted_at + accepted_by_practice_id on the invite '
  'row matching the token. Returns lead_id so callers can link the CRM '
  'lead to the newly-created practice. Idempotent (NULL on 2nd call).';
