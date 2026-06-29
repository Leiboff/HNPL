-- ─── Patient practice discovery — safe directory view ─────────────────
--
-- Problem this fixes
-- ──────────────────
-- The patient "Find a Practice" page (app/patient/explore/page.tsx)
-- queries the `practices` table as the logged-in patient. Every
-- existing SELECT policy on `practices` is relationship-scoped
-- (member, owner, platform admin, patient-with-an-existing-plan,
-- brand admin) — there is NO policy that lets a patient read all
-- approved practices for discovery. Net effect: the patient only
-- sees practices they ALREADY have a plan with. Discovery is broken.
--
-- Why a VIEW instead of a permissive policy on `practices`
-- ─────────────────────────────────────────────────────────
-- A blanket `USING (status = 'approved')` policy on the table would
-- fix discovery BUT would let any logged-in patient read EVERY column
-- on every approved practice — including `bank_account_number`,
-- `branch_code`, `bank_name`, `account_holder`, `account_type`,
-- `fee_percent` (BetterNow's commercial commission term),
-- `owner_id`, and the admin/audit fields. RLS is row-level, not
-- column-level. A view is an allowlist of COLUMNS: only the columns
-- in the view's SELECT list can be reached through it, and any column
-- added to `practices` LATER stays invisible by default. That
-- safe-by-default property is the entire point.
--
-- Security model — `security_invoker = false` (definer/owner)
-- ───────────────────────────────────────────────────────────
-- The view is created with `security_invoker = false` so it runs
-- with the OWNER's permissions (typically `postgres` in Supabase),
-- which bypasses RLS on the underlying `practices` table. That's how
-- an authenticated patient gets to see ALL approved practices
-- through the view — RLS on the base table would otherwise re-block
-- them (the patient isn't a member/owner/admin/etc.).
--
-- The safety argument:
--   (1) The view's SELECT list is the ENTIRE column surface a patient
--       can ever reach through it. Sensitive columns are not in the
--       SELECT list — there is no "ask for column X" PostgREST verb
--       that can pull them out of the view.
--   (2) The view's WHERE clause hard-filters to status = 'approved'.
--       Pending / suspended / inactive practices are not in the view.
--   (3) Direct queries to the BASE TABLE `practices` are NOT changed.
--       A patient hitting `from('practices').select('fee_percent')`
--       still goes through the table's existing relationship-scoped
--       RLS — they're not a member/owner/etc. of any non-plan
--       practice, so they read NO rows. Banking and fee_percent
--       remain unreachable through the table.
--   (4) Internal flows (admin queue, practice dashboard, billing,
--       trading gate, banking resolver) keep querying the TABLE with
--       the existing policies. They are not repointed at the view.
--
-- The view is intentionally an allowlist + filter; if a future
-- migration adds a sensitive column to `practices`, that column
-- doesn't appear in the view unless someone deliberately CREATE OR
-- REPLACEs it. Default-safe.
--
-- GRANT
-- ─────
-- `GRANT SELECT ON practices_directory TO authenticated` — every
-- logged-in user can discover practices. NOT granted to `anon`:
-- discovery requires authentication, matching the current
-- login-gated explore page (page.tsx redirects to /login otherwise).
--
-- Idempotency
-- ───────────
-- `CREATE OR REPLACE VIEW` and `DROP ... IF EXISTS` everywhere. The
-- migration introduces no CHECK constraints.

-- ── 1. The directory view ───────────────────────────────────────────────

CREATE OR REPLACE VIEW practices_directory
  WITH (security_invoker = false)
AS
  SELECT
    id,
    name,
    specialty,
    suburb,
    city,
    practice_province,
    latitude,
    longitude,
    phone,
    email
  FROM practices
  WHERE status = 'approved';

-- ── 2. Lock down GRANTs ────────────────────────────────────────────────
--
-- REVOKE first so a re-run doesn't accumulate stale grants on anon /
-- public, then GRANT only to `authenticated`. The explore page is
-- behind a `redirect('/login')` guard so anon discovery isn't a
-- product requirement.

REVOKE ALL ON practices_directory FROM PUBLIC;
REVOKE ALL ON practices_directory FROM anon;
GRANT SELECT ON practices_directory TO authenticated;

-- ── 3. Documentation comment ────────────────────────────────────────────

COMMENT ON VIEW practices_directory IS
  'Patient-facing practice discovery. Allowlist of safe columns + status = approved. '
  'Runs security_invoker = false (definer) so authenticated patients see all approved '
  'practices through the view, while sensitive columns (banking, fee_percent, '
  'owner_id, audit timestamps, brand FK, street address, internal admin metadata) '
  'are physically absent from the SELECT list and unreachable. Direct queries to the '
  '`practices` table remain gated by the existing relationship-scoped RLS policies '
  '(members, owner, platform admin, patient-with-an-existing-plan, brand admin). '
  'Only the patient explore page should query this view; internal flows continue '
  'to query the `practices` table.';
