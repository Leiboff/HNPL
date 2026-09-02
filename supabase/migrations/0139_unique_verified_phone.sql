-- ─── One verified cell number, one patient account ─────────────────────
--
-- WHY
--
-- Three identifiers should make a second account impossible, and until now
-- only two of them did:
--
--   email    UNIQUE. auth.users.users_email_partial_key at the auth layer
--            AND profiles_email_key on the mirror. Two accounts cannot
--            share one, and never could.
--   SA ID    UNIQUE since 0097, via the sa_id_lookup_hash blind index
--            (the ID itself is AES-256-GCM with a random IV and cannot be
--            compared). Scoped `WHERE role = 'patient'` on purpose — a
--            doctor who is also a patient is two legitimate rows.
--   phone    NOTHING. profiles.phone has never carried a constraint of any
--            kind, and profiles.phone_verified_at even less so.
--
-- That gap is not theoretical. At the time of writing production holds SIX
-- duplicated numbers, and one of them sits on FIFTY accounts, forty-one of
-- them verified, spread across three months. Whatever those accounts are —
-- and they look like development testing — nothing in the system noticed,
-- nothing could have noticed, and nothing would have stopped a fifty-first.
--
-- A verified number is not a weak signal like a shared browser or a shared
-- family card. It is OTP-proven possession of a handset. Two accounts with
-- the same verified number is one person, and for a lender that is the
-- whole question.
--
-- ─── WHY A TRIGGER AND NOT A UNIQUE INDEX ───────────────────────────────
--
-- A partial unique index is what this wants to be, and it is what should
-- eventually replace this. It cannot be created today: the forty-one
-- existing rows violate it, so CREATE UNIQUE INDEX simply fails. The
-- alternatives were to delete or un-verify forty-one accounts as a side
-- effect of a security migration — which is somebody's data and somebody's
-- decision, not this file's — or to guard everything from here forward and
-- leave the legacy rows visible.
--
-- This does the second. It is strictly stronger than a "since this date"
-- index would have been, which is the version I nearly wrote: such an index
-- cannot see a NEW duplicate of an OLD number, and an old number on forty-one
-- accounts is exactly the one an attacker would pick.
--
-- RESOLVED BY 0140. The forty-one rows were one developer's test accounts
-- on one handset and were removed deliberately and separately, so
-- `profiles_verified_phone_patient_uniq` now exists and is the guarantee.
--
-- This trigger STAYS, and not out of caution — the two do different jobs.
-- The index is the guarantee: unforgettable, unbypassable by any role, and
-- race-proof without help. The trigger is the message: a BEFORE trigger
-- fires ahead of the index check, so a customer sees "this cell number is
-- already verified on another account" rather than "duplicate key value
-- violates unique constraint profiles_verified_phone_patient_uniq". Both
-- raise 23505, so one handler covers either and neither can fail silently.
-- 0140's header carries the full reasoning.
--
-- `pnpm audit:duplicate-phones` remains the way to check the invariant from
-- outside the database.
--
-- ─── WHY IT NORMALISES, AND WHY THAT IS NOT COSMETIC ────────────────────
--
-- profiles.phone is stored in TWO shapes in production today: 88 rows as
-- `+27XXXXXXXXX` and one as `0XXXXXXXXX` — and that one is verified. A
-- plain equality check is therefore evadable by anyone who types their
-- number in the other format: same handset, same OTP, no match, second
-- account. The normalising function below mirrors normalizePhoneZA in
-- lib/validation/phone.ts exactly (strip separators, accept +27/27/0, keep
-- the nine local digits, canonicalise to +27) so the two sides of this
-- system agree on what "the same number" means.
--
-- ─── WHY IT DOES NOT BYPASS FOR service_role ────────────────────────────
--
-- Every other guard trigger in this schema opens with
-- `IF hnpl_write_is_privileged() THEN RETURN NEW`, because those triggers
-- enforce WHO may write a column and the server is allowed to. This one is
-- not that. It is a uniqueness invariant, and a unique index does not make
-- an exception for the server either.
--
-- It matters concretely: every phone stamp in this codebase already runs on
-- the service-role client (app/(auth)/verify-phone/actions.ts:221 and :223,
-- app/patient/account/phoneChangeActions.ts:332). A privileged bypass here
-- would exempt all three call sites — that is to say, all of them — and
-- leave a trigger that guards nothing.
--
-- ─── SCOPE, AND THE DELIBERATE HOLE IN IT ───────────────────────────────
--
-- Patient rows only, matching 0097's precedent exactly. A practice admin
-- and a patient may share a number, because a solo dentist who is also a
-- customer is one person with two legitimate roles, and refusing that would
-- break a real signup for no fraud benefit. The lending surface is patients,
-- and that is where this bites.
--
-- ─── THE RECYCLED-NUMBER CASE ───────────────────────────────────────────
--
-- South African numbers are recycled after prolonged dormancy, so in a few
-- years a genuine new customer will be refused because a long-dead account
-- verified that number first. That is a real false positive with a real
-- remedy: an admin clears phone_verified_at on the stale row, which this
-- trigger always permits (it only ever guards a row BECOMING verified), and
-- the new customer re-verifies. It is not a reason to weaken the rule — the
-- alternative refuses nobody and catches nobody.

-- ── 1. The canonical form ──────────────────────────────────────────────
--
-- IMMUTABLE so it can back the eventual unique index. Returns NULL for
-- anything it cannot canonicalise, which the trigger reads as "not a
-- comparable number" and lets through — a malformed phone is a data-quality
-- problem, not a fraud signal, and refusing a signup over one would be the
-- wrong trade.

CREATE OR REPLACE FUNCTION hnpl_normalise_phone_za(p_phone TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  cleaned TEXT;
  local9  TEXT;
BEGIN
  -- Mirrors lib/validation/phone.ts: strip whitespace, dashes and parens,
  -- keep digits and a leading +.
  cleaned := regexp_replace(p_phone, '[\s\-()]', '', 'g');

  IF    cleaned ~ '^\+27[0-9]{9}$' THEN local9 := substr(cleaned, 4);
  ELSIF cleaned ~ '^27[0-9]{9}$'   THEN local9 := substr(cleaned, 3);
  ELSIF cleaned ~ '^0[0-9]{9}$'    THEN local9 := substr(cleaned, 2);
  ELSE  RETURN NULL;
  END IF;

  -- Mobile prefixes only (6/7/8), same as the TypeScript. A landline is not
  -- a handset and cannot receive the OTP this rule is built on.
  IF left(local9, 1) NOT IN ('6', '7', '8') THEN
    RETURN NULL;
  END IF;

  RETURN '+27' || local9;
END;
$$;

REVOKE ALL ON FUNCTION hnpl_normalise_phone_za(TEXT) FROM PUBLIC;

-- service_role only. The trigger below is SECURITY DEFINER and does not
-- need the grant; this is for the operational query that lists which
-- duplicates still have to be resolved before the unique index can replace
-- the trigger (`pnpm audit:duplicate-phones`), and for building that index
-- when the day comes. Not granted to anon/authenticated: it is a pure
-- string function and harmless, but 0125 made EXECUTE an allow-list and a
-- grant nobody needs is a grant nobody will re-examine.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hnpl_normalise_phone_za(TEXT) TO service_role';
  END IF;
END $$;

COMMENT ON FUNCTION hnpl_normalise_phone_za(TEXT) IS
  'Canonical +27XXXXXXXXX form of a South African mobile number, or NULL if '
  'the input is not one. Mirrors normalizePhoneZA in lib/validation/phone.ts '
  'so the database and the application agree on what "the same number" '
  'means — production stores both +27… and 0… shapes, and an equality '
  'comparison between them is evadable. IMMUTABLE so it can back an index.';

-- ── 2. The guard ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION enforce_unique_verified_phone()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  canonical TEXT;
  taken_by  UUID;
BEGIN
  -- Nothing to guard unless this row ends up a VERIFIED PATIENT phone.
  IF NEW.role IS DISTINCT FROM 'patient'
     OR NEW.phone_verified_at IS NULL
     OR NEW.phone IS NULL THEN
    RETURN NEW;
  END IF;

  -- An UPDATE that touches neither the number, its verification, nor the
  -- role cannot introduce a collision — and profiles is updated constantly
  -- (login counts, passkey prompts, onboarding flags). Skipping those keeps
  -- this off the hot path entirely.
  IF TG_OP = 'UPDATE'
     AND NEW.phone             IS NOT DISTINCT FROM OLD.phone
     AND NEW.phone_verified_at IS NOT DISTINCT FROM OLD.phone_verified_at
     AND NEW.role              IS NOT DISTINCT FROM OLD.role THEN
    RETURN NEW;
  END IF;

  canonical := hnpl_normalise_phone_za(NEW.phone);
  IF canonical IS NULL THEN
    RETURN NEW;   -- not a comparable number; see the header
  END IF;

  -- Serialise concurrent verifications of the SAME number. Without this,
  -- two requests can both read "nobody has it" and both write, which is the
  -- one thing a trigger does and a unique index does not — and it is
  -- reachable here, because a fraud ring racing two signups on one handset
  -- is a deliberate act rather than a coincidence. Transaction-scoped, so
  -- it releases on commit or rollback with nothing to clean up.
  PERFORM pg_advisory_xact_lock(hashtext('hnpl_verified_phone:' || canonical));

  SELECT p.id INTO taken_by
    FROM profiles p
   WHERE p.id   <> NEW.id
     AND p.role  = 'patient'
     AND p.phone_verified_at IS NOT NULL
     AND hnpl_normalise_phone_za(p.phone) = canonical
   LIMIT 1;

  IF taken_by IS NOT NULL THEN
    -- unique_violation so a caller can recognise it structurally rather
    -- than by matching on message text. The message names neither the other
    -- account nor its owner: whoever is holding the handset is entitled to
    -- know the number is spoken for, and to nothing else about who has it.
    RAISE EXCEPTION
      'this cell number is already verified on another account'
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_unique_verified_phone() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_enforce_unique_verified_phone ON profiles;
CREATE TRIGGER trg_enforce_unique_verified_phone
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION enforce_unique_verified_phone();

COMMENT ON FUNCTION enforce_unique_verified_phone() IS
  'Refuses a patient row becoming verified on a cell number another patient '
  'has already verified — the constraint profiles.phone has never had, and '
  'the reason production reached fifty accounts on one number unnoticed. '
  'Compares the normalised form (two shapes are stored, so equality is '
  'evadable) and takes an advisory lock so a concurrent pair cannot both '
  'pass. Deliberately does NOT bypass for service_role: every phone stamp '
  'in the codebase runs on that client, so a bypass would exempt every call '
  'site. Stands in for a unique index until the legacy duplicates are '
  'resolved — see the header of 0139.';
