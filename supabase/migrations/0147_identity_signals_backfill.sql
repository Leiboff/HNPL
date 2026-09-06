-- ─── Backfill for databases whose 0138 means the other thing ─────────────
--
-- ─── THE PROBLEM THIS EXISTS FOR ─────────────────────────────────────────
--
-- Version 0138 was claimed twice, by two different migrations, in two
-- different places:
--
--   production        recorded 0138 as `identity_signals`, applied from
--                     claude/outstanding-migrations-9rm40y, a branch that
--                     never merged.
--   master            carried 0138 as `reverse_geocode_rate_limit`, which
--                     was never applied to production.
--
-- The reconciliation restored `0138_identity_signals.sql` to the repo and
-- renumbered the rate-limit file to 0146. That is correct for production and
-- correct for any database built from scratch, and it leaves one case wrong:
--
--   a database that applied master's OLD 0138 (the rate-limit one) already
--   records version 0138. Replay is by VERSION, not by content, so it now
--   treats `0138_identity_signals.sql` as applied and skips it. 0146 only
--   recreates the rate-limit function, so identity_signals, fraud_decisions
--   and their functions, triggers and policies never arrive — silently, on
--   a database that reports itself fully migrated.
--
-- Silently missing security tables is the worst shape a drift can take, so
-- this repairs it forward rather than relying on every operator running
-- `supabase migration repair` by hand.
--
-- ─── WHY THIS IS SAFE TO RUN WHERE THE OBJECTS ALREADY EXIST ─────────────
--
-- Every statement below is idempotent, and deliberately so: CREATE TABLE /
-- INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP … IF EXISTS before
-- each TRIGGER and POLICY, and grants that are already held. On production —
-- where all of this landed as 0138 — it is a no-op that changes nothing.
--
-- The definitions are a faithful copy of 0138's. The REASONING for each one
-- lives there and is not repeated here; this file is a repair, and two copies
-- of an argument is two places for it to rot. 0138 remains the file to read
-- and the file to edit — and it is deliberately NOT edited to add this,
-- because editing an already-applied migration is precisely what produced
-- the reverse_geocode drift this whole sequence exists to clean up.

CREATE TABLE IF NOT EXISTS identity_signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
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

GRANT SELECT          ON identity_signals TO authenticated;
GRANT SELECT, UPDATE  ON fraud_decisions  TO authenticated;
GRANT ALL             ON identity_signals, fraud_decisions TO service_role;
