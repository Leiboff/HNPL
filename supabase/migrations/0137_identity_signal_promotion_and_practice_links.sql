-- ─── Two gaps in 0136, closed ──────────────────────────────────────────
--
-- 0136 shipped the ledger and the link count. Reviewing what actually fed
-- it found two problems, both of which made the control quieter than it
-- looks:
--
-- ─── (1) THE LEDGER WAS ALMOST EMPTY ───────────────────────────────────
--
-- Signals were recorded at exactly one place: the credit claim. Everything
-- learned at signup and during onboarding was discarded.
--
-- The reason was structural rather than an oversight. A row only counts
-- toward anyone once it carries an identity_hash, and identity_hash does
-- not exist until Didit approves — which arrives as a SERVER-TO-SERVER
-- WEBHOOK. At that moment there is no browser: no device cookie, and an IP
-- belonging to Didit rather than to the applicant. The one moment we learn
-- who someone is, is the one moment we cannot see how they arrived.
--
-- Recording the pending hash at submit-time instead would have solved the
-- sparsity and broken the invariant that makes this table safe: that a
-- non-null identity_hash means a VERIFIED person. Anyone could then spray
-- identity submissions carrying other people's ID numbers and write those
-- identities into the ledger against their own device.
--
-- So: record at the user's real requests with identity_hash NULL, and
-- PROMOTE those rows when verification lands. The signals are captured
-- where the browser is; they start counting only once a registry and a
-- biometric check agree the person is real. The invariant is unchanged —
-- promotion is the only thing that ever sets identity_hash on an existing
-- row, and it is reachable only from the webhook that just approved them.
--
-- ─── (2) THE COLLUSION SIGNAL HAD NO PRODUCER ──────────────────────────
--
-- identityGraph.ts scored `singlePracticeConcentration` and nothing
-- computed it. This adds the query that does.
--
-- It matters more than its weight suggests. The practice is paid 94%
-- UPFRONT, which makes the payout the exfiltration channel and a captured
-- or colluding practice the highest-value attack on this business model. A
-- ring of rented identities has to bill THROUGH somebody, and if the same
-- somebody appears behind every linked identity, that is the shape of the
-- attack rather than a coincidence.
--
-- It is corroboration, never a decision: a rural town has one clinic and
-- its patients legitimately share it. See the minimum-linkage rule in
-- lib/security/identityGraph.ts for why a concentration figure over a
-- handful of identities is not allowed to mean anything.

-- ─── promote_identity_signals ──────────────────────────────────────────
--
-- Attach a now-verified identity to the rows this profile wrote before it
-- had one.
--
-- ONLY EVER FILLS A NULL. The WHERE clause cannot overwrite an
-- identity_hash that is already set, so a second call, a replayed webhook,
-- or a later re-verification under a different ID can never rewrite
-- history — it only ever adopts rows that belong to nobody yet. That makes
-- this idempotent, which matters because webhook delivery is at-least-once.
--
-- Bounded to rows younger than the retention horizon so a long-dormant
-- account that verifies years later does not suddenly resurrect signals
-- from a device it no longer has.
CREATE OR REPLACE FUNCTION promote_identity_signals(
  p_profile_id    UUID,
  p_identity_hash TEXT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  promoted INT;
BEGIN
  IF p_profile_id IS NULL OR p_identity_hash IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE identity_signals
     SET identity_hash = p_identity_hash
   WHERE profile_id    = p_profile_id
     AND identity_hash IS NULL
     AND occurred_at   >= now() - interval '180 days';

  GET DIAGNOSTICS promoted = ROW_COUNT;
  RETURN promoted;
EXCEPTION WHEN OTHERS THEN
  -- Same posture as record_identity_signal: this runs inside the webhook
  -- that persists an approved verification, and losing the promotion must
  -- never cost the applicant their approval.
  RETURN 0;
END;
$$;

-- ─── linked_practice_concentration ─────────────────────────────────────
--
-- Given the applicant's correlation keys, look at the OTHER identities
-- standing on them and report where their plans were billed.
--
-- Returns three numbers and no judgement:
--   linked_identities  — distinct verified identities sharing any key
--   linked_plans       — plans belonging to those identities
--   distinct_practices — how many practices billed them
--
-- The caller decides what that shape means. Putting the threshold here
-- would bury it in SQL, away from the household-versus-ring reasoning and
-- the tests that pin it.
--
-- Deliberately counts plans in ANY status. A ring that was refused, or
-- that abandoned half its applications, is still a ring — filtering to
-- successful plans would make the signal quietest exactly where the
-- control had already started working.
CREATE OR REPLACE FUNCTION linked_practice_concentration(
  p_identity_hash TEXT,
  p_kinds         TEXT[],
  p_hashes        TEXT[]
)
RETURNS TABLE (linked_identities INT, linked_plans INT, distinct_practices INT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH probes AS (
    SELECT u.kind, u.signal_hash
    FROM unnest(p_kinds, p_hashes) AS u(kind, signal_hash)
  ),
  linked AS (
    -- Distinct OTHER identities on any of the applicant's keys, with the
    -- accounts they used. One identity may hold several profiles.
    SELECT DISTINCT s.identity_hash, s.profile_id
    FROM identity_signals s
    JOIN probes p
      ON  p.kind        = s.kind
      AND p.signal_hash = s.signal_hash
    WHERE s.identity_hash IS NOT NULL
      AND s.identity_hash IS DISTINCT FROM p_identity_hash
  )
  SELECT
    (SELECT COUNT(DISTINCT identity_hash) FROM linked)::INT,
    COUNT(pl.id)::INT,
    COUNT(DISTINCT pl.practice_id)::INT
  FROM linked l
  LEFT JOIN plans pl ON pl.patient_id = l.profile_id;
$$;

REVOKE ALL ON FUNCTION promote_identity_signals(UUID, TEXT)                  FROM PUBLIC;
REVOKE ALL ON FUNCTION linked_practice_concentration(TEXT, TEXT[], TEXT[])   FROM PUBLIC;

GRANT EXECUTE ON FUNCTION promote_identity_signals(UUID, TEXT)                TO service_role;
GRANT EXECUTE ON FUNCTION linked_practice_concentration(TEXT, TEXT[], TEXT[]) TO service_role;

COMMENT ON FUNCTION promote_identity_signals(UUID, TEXT) IS
  'Attaches a newly verified identity to the profile signals recorded before verification. '
  'Only ever fills a NULL identity_hash, so it is idempotent and cannot rewrite history.';
