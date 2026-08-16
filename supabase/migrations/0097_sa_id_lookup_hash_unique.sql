-- ─── One SA ID = one patient account ────────────────────────────────────────
--
-- Phase 2 of the work begun in 0096, which added profiles.sa_id_lookup_hash
-- (an HMAC-SHA256 blind index) precisely so that uniqueness could be
-- expressed on something Postgres can compare. sa_id_number itself is
-- AES-256-GCM with a fresh random IV per call, so a UNIQUE constraint on
-- it accepts every duplicate and means nothing.
--
-- WHY PARTIAL ON role = 'patient', NOT GLOBAL
--   A global unique would be wrong, and the audit proved it rather than
--   guessed it: one duplicate group held practice_admin, practice_provider
--   AND patient rows on a single ID. A doctor who is also a patient of the
--   platform is TWO legitimate accounts — different roles, different
--   surfaces, different login — and a global constraint would refuse the
--   second one. profiles.sa_id_number is also written for practice staff
--   (via the auth trigger in 0033, from lib/brand/inviteMember.ts's invite
--   metadata), so staff rows genuinely do live in this column.
--
--   The rule being enforced is the one that was asked for: one SA ID = one
--   PATIENT account. Staff rows are out of its scope entirely.
--
-- WHY ALSO PARTIAL ON NOT NULL
--   Rows with no SA ID on file keep sa_id_lookup_hash NULL. NULLs never
--   collide in Postgres, so they would be excluded from a unique index in
--   any case — stating it in the predicate keeps the index small and makes
--   the intent legible rather than incidental.
--
--   Note the corollary, because it is the sharp edge of this design: a row
--   with an SA ID but a NULL hash is INVISIBLE to this constraint. That is
--   why scripts/backfill-sa-id-lookup-hash.ts exits non-zero unless the
--   count of such rows is zero, and why both patient write paths derive the
--   hash inside encryptId's own try/catch — a write that lands with a NULL
--   hash is a duplicate this migration cannot see.
--
-- PRECONDITION — this migration FAILS on existing duplicates, by design
--   CREATE UNIQUE INDEX is not advisory. Before applying it, the duplicate
--   patient rows must already have been resolved: see
--   scripts/strip-duplicate-sa-ids.ts, which keeps one account per SA ID
--   and NULLs sa_id_number + sa_id_lookup_hash on the rest (never deleting
--   an account, never touching plans or payment history, and writing a
--   restore file first). Run scripts/audit-sa-id-duplicates.ts to confirm
--   zero remaining patient-side duplicates before pushing this.
--
--   The failure mode if you skip that step is loud and safe — the migration
--   aborts and nothing changes.
--
-- ENFORCEMENT LEVEL
--   This is the server-side floor, deliberately below the application. The
--   app also refuses a duplicate at the point of entry with a message that
--   tells the patient to log in (app/checkout/[token]/actions.ts and
--   lib/onboarding/actions.ts), but a direct INSERT that bypasses the app
--   entirely still hits this index. Application checks are a race window;
--   the index is the thing that actually holds.
--
-- WHAT THIS DOES NOT DO
--   It does not validate that an SA ID belongs to the person entering it —
--   lib/validation.ts's validateSaId checks the checksum and embedded date,
--   not ownership. The practical consequence is that the FIRST account to
--   claim an ID becomes its permanent owner. That is a product decision,
--   not something this index can resolve.

CREATE UNIQUE INDEX IF NOT EXISTS profiles_sa_id_lookup_hash_patient_uniq
  ON profiles(sa_id_lookup_hash)
  WHERE role = 'patient' AND sa_id_lookup_hash IS NOT NULL;

COMMENT ON INDEX profiles_sa_id_lookup_hash_patient_uniq IS
  'One SA ID = one patient account. Unique on the HMAC blind index rather '
  'than on sa_id_number, which is AES-256-GCM with a random IV and cannot '
  'be compared. Partial on role=''patient'' because practice staff also '
  'carry an sa_id_number and a doctor who is also a patient is two '
  'legitimate accounts. A row whose hash is NULL is invisible here — see '
  'scripts/backfill-sa-id-lookup-hash.ts.';
