-- ─── Till/device auth for /practice/pos ─────────────────────────────────────
--
-- BACKGROUND
--   /practice/pos issuance today requires an ordinary logged-in staff
--   member (see app/practice/pos/actions.ts). The locked requirement is a
--   genuine kiosk model instead: a practice manager registers a physical
--   till PC ONCE (a short-lived, one-time registration code exchanged for
--   a long-lived, PRACTICE-SCOPED device credential — not tied to any one
--   staff member), and from then on the till authenticates itself via
--   that device credential plus a recurring daily/idle PIN unlock. "No
--   login per transaction" is the goal; "session never expires" is
--   forbidden — the device credential alone is deliberately NOT
--   sufficient to issue a bill (see till_devices.unlocked_at below).
--
--   This is a NEW, PARALLEL auth mechanism scoped ONLY to /practice/pos's
--   four till actions (issue/expire/read-stage/acknowledge) and the till's
--   own page load. It does not touch, weaken, or replace normal per-user
--   Supabase login anywhere else — including the MANAGER actions that
--   administer these devices, which stay on ordinary login +
--   is_practice_manager(), same as every other manager action in this
--   codebase (app/practice/members/actions.ts's guardManager()).
--
-- HASHING
--   Registration codes, the practice PIN, and the device secret are all
--   hashed the same way OTP codes already are in this codebase
--   (lib/sms/otp.ts's hashOtpCode: SHA-256(value + a server-held pepper),
--   computed in Node — see lib/auth/tillDevice.ts). The plaintext value
--   NEVER enters SQL or this table — every function below takes an
--   already-hashed value, mirroring prepare_phone_verification/
--   verify_phone_otp (migration 0052)'s p_code_hash parameter, not a raw
--   code the function hashes itself.

-- ── 1. till_devices ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS till_devices (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id       UUID        NOT NULL REFERENCES practices(id),
  -- SHA-256(secret + pepper). UNIQUE gives us the index this column needs
  -- for the device lookup on every till action — no separate CREATE INDEX.
  secret_hash       TEXT        NOT NULL UNIQUE,
  registered_by     UUID        REFERENCES profiles(id),
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ,
  revoked_by        UUID        REFERENCES profiles(id),
  -- Authority state — deliberately separate from the credential itself.
  -- unlocked_at must fall on the SAME CALENDAR DAY as "now" (checked in
  -- application code, lib/auth/tillDevice.ts) AND last_activity_at must
  -- be within the idle-timeout window for the device to have authority to
  -- issue. Neither condition is cached client-side — every till action
  -- re-checks both, server-side, on every call.
  unlocked_at       TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ,
  -- PIN brute-force guard (mirrors phone_verifications.attempts from
  -- migration 0052, extended with a time-boxed lockout per this task's
  -- explicit requirement — a locked-out till rejects even a SUBSEQUENTLY
  -- correct PIN until pin_locked_until elapses).
  pin_attempts      SMALLINT    NOT NULL DEFAULT 0,
  pin_locked_until  TIMESTAMPTZ,
  -- Manager-assigned friendly name ("Front desk PC"), optional.
  label             TEXT
);

CREATE INDEX IF NOT EXISTS till_devices_practice_id_idx ON till_devices(practice_id);

ALTER TABLE till_devices ENABLE ROW LEVEL SECURITY;

-- Manager-only read/administer (list devices, revoke, relabel) — the SAME
-- capability (can_manage_practice via is_practice_manager) every other
-- practice-admin screen in this codebase uses, on the caller's OWN
-- authenticated client, same as updateMember in app/practice/members/
-- actions.ts. No INSERT policy: device rows are minted exclusively by
-- redeem_till_registration_code below (SECURITY DEFINER — runs as the
-- function owner, needs no table grant for the anon caller). No DELETE
-- policy: devices are revoked (revoked_at), never deleted — that's the
-- audit trail.
CREATE POLICY "practice_manager_select_till_devices"
  ON till_devices FOR SELECT
  USING (is_practice_manager(practice_id));

CREATE POLICY "practice_manager_update_till_devices"
  ON till_devices FOR UPDATE
  USING (is_practice_manager(practice_id))
  WITH CHECK (is_practice_manager(practice_id));

-- The UNLOCK/idle-refresh writes (last_activity_at, unlocked_at,
-- pin_attempts, pin_locked_until from an actual till action) have NO
-- policy here on purpose — there is no user session in that path at all;
-- those writes go through the service-role client (bypasses RLS
-- unconditionally), same posture as checkout_sessions' own writes.

-- ── 2. till_device_registration_codes ────────────────────────────────────
CREATE TABLE IF NOT EXISTS till_device_registration_codes (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id        UUID        NOT NULL REFERENCES practices(id),
  code_hash          TEXT        NOT NULL UNIQUE,
  created_by         UUID        REFERENCES profiles(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  used_at            TIMESTAMPTZ,
  used_by_device_id  UUID        REFERENCES till_devices(id)
);

CREATE INDEX IF NOT EXISTS till_device_registration_codes_practice_id_idx
  ON till_device_registration_codes(practice_id);

ALTER TABLE till_device_registration_codes ENABLE ROW LEVEL SECURITY;

-- Manager can see + create codes for their own practice on their own
-- authenticated client (same pattern as till_devices above). Marking a
-- code used happens exclusively inside redeem_till_registration_code
-- (SECURITY DEFINER) — no UPDATE policy needed for that.
CREATE POLICY "practice_manager_select_till_registration_codes"
  ON till_device_registration_codes FOR SELECT
  USING (is_practice_manager(practice_id));

CREATE POLICY "practice_manager_insert_till_registration_codes"
  ON till_device_registration_codes FOR INSERT
  WITH CHECK (is_practice_manager(practice_id));

-- ── 3. practices.till_pin_hash ────────────────────────────────────────────
-- One PIN per PRACTICE (not per device, not per staff member — the
-- locked requirement is explicit: "a lightweight unlock (short
-- practice-level PIN"). Nullable: a practice with no PIN set cannot
-- unlock ANY of its devices — setTillPin (Build B) is the only writer,
-- covered by practices' EXISTING is_practice_manager UPDATE policy
-- (migration 0034/0035 GROUP 1) — no new policy needed for this column.
ALTER TABLE practices
  ADD COLUMN IF NOT EXISTS till_pin_hash TEXT;

COMMENT ON COLUMN practices.till_pin_hash IS
  'SHA-256(pin + pepper), same hashing as till_devices.secret_hash and '
  'till_device_registration_codes.code_hash (lib/auth/tillDevice.ts). '
  'NULL = no PIN configured yet = no device at this practice can unlock. '
  'Set/reset by a manager (setTillPin) — resetting also clears '
  'pin_attempts/pin_locked_until on every device at the practice, since '
  'changing the PIN is the recovery path for both "forgotten PIN" and '
  '"PIN may be compromised."';

-- ── 4. checkout_sessions.issued_via_device_id ────────────────────────────
-- Audit trail: which device issued this bill. Nullable for schema
-- hygiene against any future non-device issuance path; in practice every
-- row is stamped once issueCounterSession moves to device auth (Build D).
-- Not duplicated onto plans/applications — checkout_sessions already
-- maps 1:1 to plan_id, so a join gives full attribution without a
-- two-place-update problem.
ALTER TABLE checkout_sessions
  ADD COLUMN IF NOT EXISTS issued_via_device_id UUID REFERENCES till_devices(id);

-- ── 5. redeem_till_registration_code ─────────────────────────────────────
-- Atomic verify+mint+consume, mirroring get_invitation_by_token's
-- closed-surface pattern: the ONLY anon-reachable surface for minting a
-- till_devices row. Takes ALREADY-HASHED values for both the entered
-- registration code and the freshly-generated device secret — the
-- plaintext of neither ever reaches SQL (see lib/auth/tillDevice.ts,
-- which generates the secret, hashes both, and is the only caller).
--
-- Row-locks the code (FOR UPDATE) before deciding, so two concurrent
-- redemption attempts on the same code can't both succeed.
--
-- Returns a single row: (result, device_id, practice_id).
--   result = 'ok'           -> device_id/practice_id are the new device.
--   result = 'invalid_code' -> no such code hash.
--   result = 'already_used' -> code was already redeemed.
--   result = 'expired'      -> code's expires_at has passed.
-- device_id/practice_id are NULL on any non-'ok' result.
CREATE OR REPLACE FUNCTION redeem_till_registration_code(
  p_code_hash   TEXT,
  p_secret_hash TEXT
) RETURNS TABLE (result TEXT, device_id UUID, practice_id UUID)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code      till_device_registration_codes%ROWTYPE;
  v_device_id UUID;
BEGIN
  SELECT * INTO v_code
    FROM till_device_registration_codes
   WHERE code_hash = p_code_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_code'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF v_code.used_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_used'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF v_code.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO till_devices (practice_id, secret_hash)
  VALUES (v_code.practice_id, p_secret_hash)
  RETURNING id INTO v_device_id;

  UPDATE till_device_registration_codes
     SET used_at = now(), used_by_device_id = v_device_id
   WHERE id = v_code.id;

  RETURN QUERY SELECT 'ok'::TEXT, v_device_id, v_code.practice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION redeem_till_registration_code(TEXT, TEXT) TO anon, authenticated;

COMMENT ON FUNCTION redeem_till_registration_code(TEXT, TEXT) IS
  'Atomic verify+mint+consume for till device registration. Takes '
  'ALREADY-HASHED values for both the entered code and the freshly '
  'generated device secret — plaintext never reaches SQL. Row-locks the '
  'code before deciding so a concurrent double-redemption is impossible. '
  'Anon-callable: the till has no user session at registration time.';
