-- ─── SA ID deterministic lookup hash (blind index) ──────────────────────────
--
-- Resurrection of the column first added as 0085_sa_id_lookup_hash.sql in
-- commit 61743e5 and reverted wholesale by 500fe3b. The revert note said
-- backend dedup-by-ID belongs in the underwriting layer if ever wanted;
-- that is where we now are. Renumbered to 0096 because 0085 has since been
-- taken by 0085_checkout_sessions.sql — the CLI keys on the leading digits,
-- so the old number can never be reused.
--
-- WHY A DERIVED COLUMN AND NOT A UNIQUE CONSTRAINT ON sa_id_number
--   profiles.sa_id_number is written via lib/idEncryption.ts's encryptId(),
--   AES-256-GCM with a FRESH RANDOM IV on every call. Two rows holding the
--   same SA ID therefore hold two completely different ciphertexts.
--   Postgres cannot see that they are the same value:
--
--     • UNIQUE (sa_id_number)  — accepts every duplicate. Meaningless.
--     • WHERE sa_id_number = encryptId(x)  — never matches, even for the
--       exact plaintext that produced the stored value.
--
--   Uniqueness (and lookup) must therefore be enforced on a DETERMINISTIC
--   derived value.
--
-- WHAT THIS COLUMN IS
--   HMAC-SHA256 of the PLAINTEXT SA ID, hex-encoded, keyed by
--   SA_ID_LOOKUP_HMAC_KEY — a secret DELIBERATELY SEPARATE from
--   SA_ID_ENCRYPTION_KEY. See lib/idEncryption.ts's hashIdForLookup().
--
--   Deterministic:  same ID + same key → same hash, always. That is what
--                   makes equality lookup and a UNIQUE constraint possible.
--   One-way:        SHA-256 is not invertible, and without the key an
--                   attacker cannot even brute-force the ~10^13 SA ID
--                   space offline, which an UNKEYED hash would allow.
--   Key-separated:  a leak of the AES key exposes IDs but not linkability
--                   across a stolen hash column; a leak of the HMAC key
--                   exposes linkability but not a single ID. Neither
--                   secret alone gives both.
--
--   It does NOT weaken the existing encryption in any way: sa_id_number's
--   AES-256-GCM storage is untouched, the AES key is untouched, and this
--   column is derived from the plaintext independently. The only new
--   exposure is the hash itself, which is why no RLS SELECT policy is
--   added for it (see below).
--
-- SCOPE OF THIS MIGRATION — deliberately NOT unique yet
--   Column + index only, NULLABLE, NO uniqueness. Adding UNIQUE here would
--   fail outright on any existing duplicate, and the point of this step is
--   to MAKE the duplicates visible so a human can decide what happens to
--   them. The UNIQUE constraint is a separate, later migration, applied
--   only after that cleanup decision.
--
--   Population:
--     • going forward — the two patient ID-capture paths write it
--       alongside sa_id_number (app/checkout/[token]/actions.ts's
--       initiateCheckout, lib/onboarding/actions.ts's saveIdAndSalaryDay)
--     • existing rows  — scripts/backfill-sa-id-lookup-hash.ts, a
--       re-runnable one-time script. It cannot be done in SQL: Postgres
--       does not hold the AES key and must not be given it.
--
--   Rows with sa_id_number IS NULL keep sa_id_lookup_hash NULL forever;
--   the index is partial so they cost nothing.
--
-- RLS
--   No policy change. profiles' existing policies govern this column like
--   any other, and none of them was written to expose it: every read of
--   this column is a service-role read from a server action. Treat the
--   hash as sensitive-adjacent — it is a stable cross-record linkability
--   key for anyone who later obtains the HMAC key.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS sa_id_lookup_hash TEXT;

CREATE INDEX IF NOT EXISTS profiles_sa_id_lookup_hash_idx
  ON profiles(sa_id_lookup_hash)
  WHERE sa_id_lookup_hash IS NOT NULL;

COMMENT ON COLUMN profiles.sa_id_lookup_hash IS
  'HMAC-SHA256(SA_ID_LOOKUP_HMAC_KEY, plaintext SA ID), hex-encoded. '
  'Deterministic blind index: sa_id_number itself is AES-256-GCM with a '
  'random IV and can neither be equality-matched nor made UNIQUE. '
  'Populated on write by the patient ID-capture paths and backfilled by '
  'scripts/backfill-sa-id-lookup-hash.ts. NOT unique in this migration — '
  'uniqueness lands separately, after duplicate cleanup. Never exposed '
  'via a client-facing SELECT; service-role reads only.';
