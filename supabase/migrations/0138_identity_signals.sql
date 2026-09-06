-- ─── Linking accounts that share a device, card, phone or network ───────
--
-- WHY (audit round three, and rounds one and two before it)
--
-- Bot / synthetic-identity defence has scored 2/10 in three consecutive
-- security audits and is the only finding that has never moved. For a
-- lend-money-to-strangers product it is the main event: every other control
-- in this schema assumes the person in front of it is one person.
--
-- Today the platform can tell that two accounts share an SA ID (0097's
-- unique index) and nothing else. It cannot tell that fifty "different"
-- customers are one person on one phone with one card, which is what
-- synthetic-identity fraud actually looks like.
--
-- ─── WHY NOW, SPECIFICALLY ──────────────────────────────────────────────
--
-- This data cannot be backfilled. Correlation works by having seen a signal
-- BEFORE you need to ask about it — the 87 accounts that already exist can
-- never be device-fingerprinted retrospectively. Every day this is not
-- collecting is a day of blind spots that cannot be recovered, which is why
-- it goes in before launch rather than after the first fraud loss.
--
-- The one exception is the card signature, which 0019 has been computing
-- and storing all along (`peach:BRAND:LAST4:MMYYYY`) purely to de-duplicate
-- cards WITHIN one patient. It is identical across accounts and has never
-- been compared across them. `pnpm backfill:identity-signals` seeds it, so
-- this ships with real correlation data on day one rather than an empty
-- table. That is a SCRIPT and not migration 0139 for one reason: the stored
-- value is an HMAC under a key the database deliberately does not have, and
-- a migration could only do it by putting that key in a SQL literal — which
-- would land it in the query log, the migration history, and the repo.
--
-- ─── WHAT IS STORED, AND WHAT IS DELIBERATELY NOT ───────────────────────
--
-- Only a peppered HMAC of each signal, never the raw value. The table can
-- answer "do these two accounts share a device?" and cannot answer "what is
-- this person's IP address" — an important difference for a table that will
-- accumulate one row per account per signal forever, and the reason a
-- breach of it leaks links rather than identities.
--
-- Four kinds, and the choice of four is the whole design:
--
--   device  a first-party random id in an httpOnly cookie. NOT canvas or
--           WebGL fingerprinting: those are covert, brittle across browser
--           updates, and land differently under POPIA. A cookie is honest,
--           already disclosed (privacy policy §2.1 "Device, browser and
--           usage information … including through cookies"), and defeats
--           casual multi-accounting. A determined attacker clears it — that
--           is understood and is what the other three signals are for.
--   ip      the request IP. Weak on its own in South Africa (see below).
--   card    0019's card signature. The strongest signal here: a card is
--           expensive to obtain and hard to rotate at scale.
--   phone   the verified number. profiles.phone carries no unique index, so
--           one number can sit on many accounts today.
--
-- The privacy purpose is already stated: policy §3.1.5, "to detect, prevent
-- and investigate fraud and other unlawful activity". No policy change is
-- needed for any of the four.
--
-- ─── THE SOUTH AFRICAN CONSTRAINT ON IP ─────────────────────────────────
--
-- IP MUST NEVER BLOCK, and that is a domain fact rather than a preference.
-- South African mobile carriers NAT very aggressively: tens of thousands of
-- Vodacom, MTN and Telkom subscribers egress from the same handful of
-- addresses. Blocking on a shared IP here does not catch a fraud ring, it
-- refuses a suburb. It is recorded because it is useful in combination and
-- useful to a human reviewer, and it is capped at FLAG in 0138's companion
-- rules (lib/security/identitySignals.ts).
--
-- The same caution applies more mildly to device and card. Families share a
-- phone and a card in this product constantly — a mother paying for her
-- daughter's dentistry is the ordinary case, not the attack. So the block
-- thresholds are set where legitimate sharing has effectively stopped
-- (six-plus accounts), not where it begins.
--
-- ─── WRITE POSTURE ──────────────────────────────────────────────────────
--
-- No user INSERT policy at all: these rows are written only by the server,
-- on the service-role client. A guard trigger backs that up, on the
-- 0121/0128/0135 pattern — because a table a user could write to would let
-- an attacker plant links onto an innocent account and get THEM blocked,
-- which turns a fraud control into a denial-of-service weapon.

-- ── 1. The signal store ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS identity_signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  -- HMAC-SHA256(value, IDENTITY_SIGNAL_HMAC_KEY), hex. Never the raw value.
  value_hash    TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  hits          INT NOT NULL DEFAULT 1,
  CONSTRAINT identity_signals_kind_check
    CHECK (kind = ANY (ARRAY['device', 'ip', 'card', 'phone'])),
  CONSTRAINT identity_signals_hash_format
    CHECK (value_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identity_signals_unique UNIQUE (user_id, kind, value_hash)
);

-- The correlation lookup: "who else has this signal?" It is the only query
-- shape the rules run, and without this index it is a sequential scan on
-- every signup.
CREATE INDEX IF NOT EXISTS identity_signals_lookup_idx
  ON identity_signals (kind, value_hash);

CREATE INDEX IF NOT EXISTS identity_signals_user_idx
  ON identity_signals (user_id);

COMMENT ON TABLE identity_signals IS
  'Peppered HMACs of the device, IP, card and phone signals seen for each '
  'account, for linking accounts that share them. Stores no raw values — it '
  'can answer "same device?" and cannot answer "which device". Written only '
  'by the server on the service-role client; see 0138 for why a user-'
  'writable version would be a denial-of-service weapon.';

-- ── 2. The decision log ────────────────────────────────────────────────
--
-- Every non-allow outcome is recorded, with the rule that fired and the
-- counts that triggered it. Two reasons, and the second is the operational
-- one: a customer who was wrongly refused has to be findable and
-- releasable, by name, without reading application logs.

CREATE TABLE IF NOT EXISTS fraud_decisions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES profiles(id) ON DELETE CASCADE,
  surface      TEXT NOT NULL,
  decision     TEXT NOT NULL,
  rule         TEXT,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at  TIMESTAMPTZ,
  released_by  UUID REFERENCES profiles(id),
  release_note TEXT,
  CONSTRAINT fraud_decisions_decision_check
    CHECK (decision = ANY (ARRAY['flag', 'block'])),
  CONSTRAINT fraud_decisions_release_pair
    CHECK ((released_at IS NULL) = (released_by IS NULL))
);

CREATE INDEX IF NOT EXISTS fraud_decisions_user_idx    ON fraud_decisions (user_id);
CREATE INDEX IF NOT EXISTS fraud_decisions_open_idx    ON fraud_decisions (created_at DESC)
  WHERE released_at IS NULL;

COMMENT ON TABLE fraud_decisions IS
  'Every flag or block the identity-signal rules produced, with the rule '
  'name and the counts behind it. An admin releases a wrongly-blocked '
  'customer by stamping released_at/released_by, which the evaluator then '
  'honours. Allows are not recorded — they are the overwhelming majority '
  'and their absence is not evidence of anything.';

-- ── 3. Correlation, as one function ────────────────────────────────────
--
-- Returns, per kind, how many OTHER accounts share at least one signal
-- value with this one. SECURITY DEFINER because the answer necessarily
-- spans accounts the caller cannot see, and service_role-only because the
-- shape of the link graph is exactly what an attacker probing for a
-- threshold would want.

CREATE OR REPLACE FUNCTION identity_link_counts(p_user_id UUID)
RETURNS TABLE (kind TEXT, shared_accounts INT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT mine.kind,
         COUNT(DISTINCT theirs.user_id)::int AS shared_accounts
    FROM identity_signals mine
    JOIN identity_signals theirs
      ON  theirs.kind       = mine.kind
      AND theirs.value_hash = mine.value_hash
      AND theirs.user_id   <> mine.user_id
   WHERE mine.user_id = p_user_id
   GROUP BY mine.kind;
$$;

REVOKE ALL ON FUNCTION identity_link_counts(UUID) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION identity_link_counts(UUID) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION identity_link_counts(UUID) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION identity_link_counts(UUID) TO service_role';
  END IF;
END $$;

COMMENT ON FUNCTION identity_link_counts(UUID) IS
  'Per signal kind, how many OTHER accounts share a value with this one. '
  'SECURITY DEFINER (the answer spans accounts the caller cannot see) and '
  'service_role only (the link graph is what an attacker probing for a '
  'threshold would want). See audit R3 fraud work.';

-- ── 3b. Recording, as one function ─────────────────────────────────────
--
-- The server writes signals through here rather than with a direct upsert,
-- for three reasons that are all about keeping the write surface one shape:
--
--   • It is the only place `hits`/`last_seen_at`/`first_seen_at` semantics
--     live. A returning device must advance `hits` and `last_seen_at` and
--     must NOT move `first_seen_at`, because "this card appeared on a second
--     account three months later" reads very differently from "…within the
--     same hour", and that distinction is the reviewer's main tool.
--   • It validates the kind and the hash shape server-side. The CHECKs above
--     would catch a bad row anyway, but as a failed statement mid-signup;
--     here a malformed signal is skipped and the rest still land.
--   • It is service_role-only, so there is exactly one grant to audit.
--
-- p_signals is a JSONB array of {"kind": ..., "value_hash": ...}. Anything
-- that does not match is ignored rather than raising: a signup must not fail
-- because one of four optional signals was malformed.

CREATE OR REPLACE FUNCTION record_identity_signals(p_user_id UUID, p_signals JSONB)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  written INT := 0;
  prior   TEXT;
BEGIN
  IF p_user_id IS NULL OR p_signals IS NULL OR jsonb_typeof(p_signals) <> 'array' THEN
    RETURN 0;
  END IF;

  -- The guard trigger refuses anything that is not a privileged write. This
  -- function IS the privileged writer, so it says so explicitly rather than
  -- relying on the caller's role — that keeps it correct if it is ever
  -- called from another SECURITY DEFINER function instead of the
  -- service-role client.
  --
  -- Saved and restored rather than switched on and off. From PostgREST each
  -- RPC is its own transaction and the two are the same thing, but a future
  -- caller that already held the bypass would otherwise have it silently
  -- revoked from underneath it by the time this returns — and it would fail
  -- open on a column-lock trigger, several statements later, somewhere that
  -- has nothing to do with this function.
  prior := COALESCE(current_setting('app.privileged_write', true), 'off');
  PERFORM set_config('app.privileged_write', 'on', true);

  INSERT INTO identity_signals (user_id, kind, value_hash)
  SELECT p_user_id, s.kind, s.value_hash
    FROM (
      SELECT DISTINCT
             e ->> 'kind'       AS kind,
             e ->> 'value_hash' AS value_hash
        FROM jsonb_array_elements(p_signals) AS e
    ) s
   WHERE s.kind = ANY (ARRAY['device', 'ip', 'card', 'phone'])
     AND s.value_hash ~ '^[0-9a-f]{64}$'
  ON CONFLICT (user_id, kind, value_hash) DO UPDATE
     SET hits         = identity_signals.hits + 1,
         last_seen_at = now();

  GET DIAGNOSTICS written = ROW_COUNT;

  PERFORM set_config('app.privileged_write', prior, true);
  RETURN written;
END;
$fn$;

REVOKE ALL ON FUNCTION record_identity_signals(UUID, JSONB) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION record_identity_signals(UUID, JSONB) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION record_identity_signals(UUID, JSONB) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION record_identity_signals(UUID, JSONB) TO service_role';
  END IF;
END $$;

COMMENT ON FUNCTION record_identity_signals(UUID, JSONB) IS
  'Upserts a batch of {kind, value_hash} signals for one account, advancing '
  'hits/last_seen_at and leaving first_seen_at alone. Malformed entries are '
  'skipped, never raised — a signup must not fail because one optional '
  'signal was bad. service_role only. See audit R3 fraud work.';

-- ── 4. Write guards ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION protect_identity_signals_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF hnpl_write_is_privileged() IS TRUE THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'identity_signals is written only by the server. A user-writable version '
    'would let an attacker plant links onto an innocent account to get that '
    'account blocked.';
END;
$$;

REVOKE ALL ON FUNCTION protect_identity_signals_write() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_protect_identity_signals_write ON identity_signals;
CREATE TRIGGER trg_protect_identity_signals_write
  BEFORE INSERT OR UPDATE OR DELETE ON identity_signals
  FOR EACH ROW
  EXECUTE FUNCTION protect_identity_signals_write();

-- fraud_decisions takes the payouts shape rather than a blanket refusal:
-- an admin RELEASES a block from the admin UI on their own session client,
-- so that the release carries a real actor id.
CREATE OR REPLACE FUNCTION protect_fraud_decisions_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed text;
BEGIN
  IF hnpl_write_is_privileged() IS TRUE THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'fraud_decisions rows are created and removed only by the server';
  END IF;

  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'only a platform admin may release a fraud decision';
  END IF;

  -- Order matters. The already-released check comes FIRST because a second
  -- release by the same admin changes released_at and release_note but not
  -- released_by — so the column-set check below would reject it with a
  -- message about the wrong thing, and an operator would go looking for a
  -- permissions bug instead of reading "already released".
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'this decision has already been released';
  END IF;

  SELECT string_agg(n.key, ', ' ORDER BY n.key)
    INTO changed
    FROM jsonb_each(to_jsonb(NEW)) AS n
   WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);

  IF changed IS DISTINCT FROM 'release_note, released_at, released_by' THEN
    RAISE EXCEPTION
      'releasing a fraud decision may change only released_at, released_by '
      'and release_note (changed: %)', COALESCE(changed, '<nothing>');
  END IF;

  IF NEW.released_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'released_by must be the admin performing the release';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION protect_fraud_decisions_write() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_protect_fraud_decisions_write ON fraud_decisions;
CREATE TRIGGER trg_protect_fraud_decisions_write
  BEFORE INSERT OR UPDATE OR DELETE ON fraud_decisions
  FOR EACH ROW
  EXECUTE FUNCTION protect_fraud_decisions_write();

-- ── 5. RLS ─────────────────────────────────────────────────────────────
--
-- No INSERT policy on either table for any user role — the server writes
-- both on the service-role client, which bypasses RLS. Admins read, and
-- admins may UPDATE fraud_decisions (the release), narrowed by the trigger
-- above to three columns.

ALTER TABLE identity_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_decisions  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_select_identity_signals" ON identity_signals;
CREATE POLICY "admins_select_identity_signals" ON identity_signals
  FOR SELECT USING (is_platform_admin());

DROP POLICY IF EXISTS "admins_select_fraud_decisions" ON fraud_decisions;
CREATE POLICY "admins_select_fraud_decisions" ON fraud_decisions
  FOR SELECT USING (is_platform_admin());

DROP POLICY IF EXISTS "admins_release_fraud_decisions" ON fraud_decisions;
CREATE POLICY "admins_release_fraud_decisions" ON fraud_decisions
  FOR UPDATE USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- ── 6. Grants ──────────────────────────────────────────────────────────
--
-- Explicit rather than inherited from ALTER DEFAULT PRIVILEGES. Two of the
-- three roles get more than they can use, and that is the intended shape:
-- RLS is the control here, not the grant. anon gets nothing at all — there
-- is no unauthenticated surface that has any business touching either table,
-- and a role with no grant cannot be talked past a policy by a future one.

GRANT SELECT          ON identity_signals TO authenticated;
GRANT SELECT, UPDATE  ON fraud_decisions  TO authenticated;
GRANT ALL             ON identity_signals, fraud_decisions TO service_role;
