-- ─── The unique index 0139 was standing in for ─────────────────────────
--
-- 0139 guarded every new verification with a trigger, and said in its own
-- header that a partial unique index was what it wanted to be and could not
-- yet become: forty-one rows shared one number, so CREATE UNIQUE INDEX
-- simply failed, and un-verifying forty-one accounts as a side effect of a
-- security migration is not a decision a migration gets to make.
--
-- Those rows are gone — they were one developer's test accounts on one
-- handset, removed deliberately and separately. Production now holds ZERO
-- duplicate verified patient numbers, so the index builds, and the
-- guarantee stops depending on a trigger firing.
--
-- ─── WHY THE TRIGGER STAYS ──────────────────────────────────────────────
--
-- Both, deliberately, and not out of caution — they do different jobs:
--
--   the index    is the GUARANTEE. It cannot be forgotten, cannot be
--                bypassed by any role including service_role, and is
--                enforced by the storage engine rather than by code that
--                has to run. It is also the only one of the two that is
--                genuinely race-proof without help.
--   the trigger  is the MESSAGE. A BEFORE trigger fires ahead of the index
--                check, so the error a caller sees is "this cell number is
--                already verified on another account" rather than
--                "duplicate key value violates unique constraint
--                profiles_verified_phone_patient_uniq". The app maps the
--                first to copy a customer standing at a practice counter
--                can act on.
--
-- Both raise SQLSTATE 23505, so isPhoneAlreadyVerifiedElsewhere recognises
-- either — which is the property that makes keeping both free rather than a
-- second thing to maintain. If the trigger is ever dropped, the constraint
-- survives and the customer gets a worse message; if the index were ever
-- dropped, the trigger still refuses. Neither failure is silent.
--
-- ─── THE PREDICATE IS THE SAME ONE, DELIBERATELY ────────────────────────
--
--   role = 'patient'              — 0097's precedent. A solo dentist who is
--                                   also a customer is one person with two
--                                   legitimate roles.
--   phone_verified_at IS NOT NULL — typing a number asserts nothing; only
--                                   the OTP does. It also means an
--                                   unverified duplicate cannot be used as
--                                   a lockout weapon against the number's
--                                   real owner.
--   hnpl_normalise_phone_za(...)  — production stored both `+27…` and `0…`,
--                                   so a raw-column index would have been
--                                   evadable by typing the other format.
--                                   IMMUTABLE, which is why 0139 defined it
--                                   that way rather than as a plain SQL
--                                   helper.

CREATE UNIQUE INDEX IF NOT EXISTS profiles_verified_phone_patient_uniq
  ON profiles (hnpl_normalise_phone_za(phone))
  WHERE role = 'patient'
    AND phone_verified_at IS NOT NULL
    AND hnpl_normalise_phone_za(phone) IS NOT NULL;

COMMENT ON INDEX profiles_verified_phone_patient_uniq IS
  'One verified cell number, one patient account — the third of the three '
  'identifiers that must never be shareable, alongside profiles_email_key '
  'and profiles_sa_id_lookup_hash_patient_uniq (0097). Indexes the '
  'NORMALISED number because both +27… and 0… shapes have been stored and a '
  'raw-column index would be evadable by typing the other one. The 0139 '
  'trigger is kept alongside it to produce a legible error; both raise '
  '23505. See the header of 0140.';
