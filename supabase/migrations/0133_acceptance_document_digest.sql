-- ─── Which text did they actually agree to? ────────────────────────────────
--
-- THE GAP (audit 2026-09-02, A-14)
--
-- profiles.terms_version records '1.0'. That answers "which version" only for
-- as long as nobody edits the clause text without bumping the version, and
-- nothing stopped them. In a dispute over an NCA credit agreement the record
-- has to survive "how do we know the text said that in August?", and a
-- version string on its own does not.
--
-- These two columns hold the SHA-256 of the rendered document at the moment
-- of acceptance. Paired with the version, the row becomes self-verifying:
-- recompute the digest of the document at that version and compare. The
-- version→digest mapping is a committed constant in lib/legal/documentHash.ts
-- and a test recomputes it from the source file on every run, so a clause
-- edited without bumping both turns the suite red.
--
-- ─── WHY ONLY profiles, AND NOT plans ──────────────────────────────────────
--
-- plans.terms_version records the acceptance made at plan activation. It is
-- an acceptance of the SAME two documents, and the version→digest mapping is
-- one-to-one and verified — so a digest column there would restate what the
-- version already determines, on the busiest write in the system
-- (claim_credit_for_plan, migration 0130, whose signature would have to
-- grow). The account-level row is where the digest earns its place: it is the
-- one written at the moment the documents were rendered.
--
-- ─── NULL MEANS "BEFORE THIS EXISTED", AND STAYS THAT WAY ──────────────────
--
-- Existing rows are NOT backfilled. Filling the current digest into a row
-- accepted last month would assert something nobody can know — that the text
-- has not changed since — and manufacturing evidence is the opposite of what
-- this column is for. A NULL digest beside a non-NULL terms_version means
-- "accepted before we recorded digests", which is the truth and is answerable
-- from git history.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS terms_doc_sha256   TEXT,
  ADD COLUMN IF NOT EXISTS privacy_doc_sha256 TEXT;

COMMENT ON COLUMN profiles.terms_doc_sha256 IS
  'SHA-256 of the rendered T&Cs document at the moment of acceptance. NULL '
  'on rows accepted before migration 0133 — never backfilled, because the '
  'current digest is not evidence about a past acceptance.';
COMMENT ON COLUMN profiles.privacy_doc_sha256 IS
  'SHA-256 of the rendered Privacy Policy at the moment of acceptance. NULL '
  'on rows predating migration 0133. See terms_doc_sha256.';

-- ── The columns are not patient-writable ───────────────────────────────────
--
-- 0122 made profiles column writes an allow-list for the row's own owner —
-- the F-05 fix, after seven columns that decide whether somebody may take
-- credit turned out to be writable by the person they describe. These two are
-- evidence about a legal act, so they belong on the same side of that line:
-- an acceptance record the subject can edit is not a record.
--
-- 0122's trigger enforces an allow-list of what an owner MAY write, so a
-- column it has never heard of is already refused. Asserted here rather than
-- assumed, because "a new column defaults to protected" is a property of that
-- migration's shape and this one depends on it.
--
-- Nothing to add, then — but the test file for this migration checks it, so
-- a future rewrite of protect_profiles_columns() to a deny-list fails loudly
-- rather than silently opening these.
