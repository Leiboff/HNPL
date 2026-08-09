-- ─── SA ID deterministic lookup hash ────────────────────────────────────────
--
-- BACKGROUND
--   profiles.sa_id_number is stored via lib/idEncryption.ts's encryptId(),
--   which is AES-256-GCM with a FRESH RANDOM IV on every call. That's the
--   right choice for at-rest confidentiality, but it means the ciphertext
--   is non-deterministic: `WHERE sa_id_number = encryptId(x)` can never
--   match, even when x is the exact plaintext that was originally
--   encrypted. There is currently NO way to look up a profile by SA ID
--   number — every existing "does this patient already have an account"
--   check (createBill, findExistingAuthUser, the anonymous checkout's
--   existing-account routing) keys exclusively on email.
--
--   The POS/counter checkout flow needs to key issuance on SA ID number,
--   which requires resolving "does a profile already exist for this ID"
--   without decrypting and comparing every row.
--
-- FIX
--   Add a separate deterministic blind index: profiles.sa_id_lookup_hash,
--   an HMAC-SHA256 (hex) of the plaintext SA ID, keyed by a DIFFERENT
--   secret (SA_ID_LOOKUP_HMAC_KEY) than the AES encryption key
--   (SA_ID_ENCRYPTION_KEY). HMAC is deterministic (same input + key always
--   produces the same output) so an equality lookup works, while a
--   attacker who only has the hash (no key) cannot invert it to the ID —
--   unlike storing the ID in plaintext or with a fast unkeyed hash.
--
--   Using a SEPARATE key from the AES key means a leak of one secret does
--   not automatically compromise the other property (confidentiality vs.
--   linkability).
--
-- SCOPE OF THIS MIGRATION
--   Column + index only. The application-side hashIdForLookup() helper and
--   the write-path wiring (populating this column when sa_id_number is
--   captured) land in the same PR as this migration — see
--   lib/idEncryption.ts and app/checkout/[token]/actions.ts. Backfilling
--   existing profiles.sa_id_number rows (which requires decrypting each
--   one once) is deliberately OUT of scope here — it's a one-time
--   maintenance script, not a hot path, and does not block new POS-issued
--   bills from using the hash going forward.
--
--   Nullable: legacy rows (signed up before this migration, or rows with
--   no sa_id_number) simply have sa_id_lookup_hash = NULL and are not
--   findable by ID lookup until backfilled.
--
--   Not exposed via any SELECT policy change — this migration adds no new
--   RLS surface. Lookups happen exclusively through service-role queries
--   (see lib/patients/findPatientBySaId.ts), never client-side. Even
--   though HMAC output isn't reversible without the key, treat it as
--   sensitive-adjacent: a leaked hash column is a stable linkability key
--   across records for anyone who later obtains the HMAC key.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS sa_id_lookup_hash TEXT;

CREATE INDEX IF NOT EXISTS profiles_sa_id_lookup_hash_idx
  ON profiles(sa_id_lookup_hash)
  WHERE sa_id_lookup_hash IS NOT NULL;

COMMENT ON COLUMN profiles.sa_id_lookup_hash IS
  'HMAC-SHA256(SA_ID_LOOKUP_HMAC_KEY, plaintext SA ID), hex-encoded. '
  'Deterministic blind index enabling exact-match lookup by SA ID number '
  '(sa_id_number itself is AES-256-GCM with a random IV and cannot be '
  'equality-matched). Populated on write going forward; NULL for rows '
  'created before this migration until backfilled. Never exposed via '
  'client-facing SELECT — service-role lookups only.';
