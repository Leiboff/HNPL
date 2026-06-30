-- ─── Practitioner discovery — safe directory view ─────────────────────
--
-- Pivots patient discovery from practice-level to PRACTITIONER-level.
-- Same allowlist + security-definer discipline as practices_directory
-- (0063) — the view's SELECT list IS the entire patient-reachable
-- column surface, sensitive columns are physically absent, and the
-- base tables keep their existing relationship-scoped RLS verbatim.
--
-- One row = one practitioner-at-a-practice. A practitioner working at
-- multiple practices appears as multiple rows; the client groups them
-- by `hpcsa_group_key` (the md5 hash of the trimmed/normalized HPCSA
-- number) so two memberships with the same HPCSA become ONE card with
-- two locations. Raw HPCSA numbers are NEVER exposed by the view —
-- only the (one-way) hash + a boolean "registered" badge.
--
-- Rows where the practitioner has no HPCSA on file are NOT dropped:
-- `hpcsa_group_key` is NULL and the client falls back to keying on
-- `member_id` (each such row becomes its own standalone card). The
-- merge key being absent must NEVER hide a practitioner.
--
-- WHY a view, not a permissive policy on `practice_members`
-- ─────────────────────────────────────────────────────────
-- `practice_members` carries provider PERSONAL banking columns
-- (`personal_bank_account_number` etc.), encrypted SA-ID, capability
-- flags, and the raw HPCSA number — all sensitive. A blanket
-- `USING (active AND role='provider' AND ...)` policy would let any
-- patient pull those columns via PostgREST. RLS is row-level, not
-- column-level. The view is an allowlist of columns; adding a new
-- sensitive column to `practice_members` later cannot leak through
-- this view unless someone deliberately CREATE OR REPLACEs it.
--
-- WHY security_invoker = false
-- ─────────────────────────────
-- `security_invoker = true` would re-apply the patient's RLS context
-- against `practice_members` and `practices` — both of which block
-- patient SELECT for non-related rows. Discovery would stay broken.
-- With definer mode, the view runs as its owner (`postgres` in
-- Supabase) and bypasses those policies. Safety is preserved by:
--   (1) the SELECT list omits every sensitive column,
--   (2) WHERE filters to role='provider' + active=TRUE + practices
--       status='approved' — only practitioners at trade-ready practices,
--   (3) the BASE TABLES keep their RLS — a patient hitting
--       `from('practice_members').select('personal_account_number')`
--       directly is still blocked (they're not a member/admin/etc.),
--       and same for `from('practices').select('bank_account_number')`,
--   (4) RAW HPCSA is hashed (md5) before exposure — patients can group
--       and verify "is the same person" without learning the raw
--       registration number.
--
-- GRANT/REVOKE
-- ────────────
-- GRANT SELECT TO authenticated; REVOKE from anon and PUBLIC. The
-- patient explore page is behind a login gate so anon discovery isn't
-- a product requirement.

-- ── 1. The directory view ──────────────────────────────────────────────

CREATE OR REPLACE VIEW practitioners_directory
  WITH (security_invoker = false)
AS
  SELECT
    -- Per-row stable id (the practice_members row id). The client uses
    -- this as the standalone-card key when hpcsa_group_key is NULL.
    pm.id                          AS member_id,

    -- HPCSA-derived grouping key. NULL when the practitioner has no
    -- HPCSA on file (the discovery layer treats NULL as "no merge —
    -- this row is its own card"). Hashed via md5 so the raw
    -- registration number never leaves the database. md5 is fine for
    -- this use (collision risk astronomically low across the HPCSA
    -- domain; we're grouping, not authenticating).
    CASE
      WHEN pm.hpcsa_number IS NULL                  THEN NULL
      WHEN LENGTH(TRIM(pm.hpcsa_number)) = 0        THEN NULL
      ELSE md5(LOWER(TRIM(pm.hpcsa_number)))
    END                            AS hpcsa_group_key,

    -- "HPCSA registered ✓" badge. We expose the boolean only — never
    -- the number itself.
    (pm.hpcsa_number IS NOT NULL
       AND LENGTH(TRIM(pm.hpcsa_number)) > 0)
                                   AS hpcsa_registered,

    -- Practitioner identity (the safe profile bits — no email, no
    -- phone, no SA-ID).
    profiles.first_name,
    profiles.last_name,
    pm.specialty,

    -- The practice this practitioner works at, with the same safe
    -- column set as practices_directory (0063).
    practices.id        AS practice_id,
    practices.name      AS practice_name,
    practices.suburb    AS practice_suburb,
    practices.city      AS practice_city,
    practices.latitude  AS practice_latitude,
    practices.longitude AS practice_longitude,
    practices.phone     AS practice_phone

  FROM practice_members pm
    JOIN profiles  ON profiles.id   = pm.user_id
    JOIN practices ON practices.id  = pm.practice_id
  WHERE pm.role        = 'provider'
    AND pm.active      = TRUE
    AND practices.status = 'approved';

-- ── 2. Lock down GRANTs ────────────────────────────────────────────────

REVOKE ALL ON practitioners_directory FROM PUBLIC;
REVOKE ALL ON practitioners_directory FROM anon;
GRANT SELECT ON practitioners_directory TO authenticated;

-- ── 3. Documentation ───────────────────────────────────────────────────

COMMENT ON VIEW practitioners_directory IS
  'Patient-facing practitioner discovery. Allowlist of safe columns — '
  'no banking, no fee_percent, no personal_*, no SA-ID, no raw HPCSA. '
  'WHERE active providers at approved practices only. HPCSA is exposed '
  'as md5(hpcsa) for client-side grouping AND a boolean "registered" '
  'badge; the raw number never leaves the DB. NULL HPCSA → NULL group '
  'key (client falls back to member_id so the row still appears, never '
  'hidden). Runs security_invoker = false (definer) so authenticated '
  'patients can read all rows without re-hitting the relationship-scoped '
  'RLS on practice_members/practices, which keep their existing policies.';
