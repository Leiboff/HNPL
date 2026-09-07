-- ─── Experian bureau enquiry log ────────────────────────────────────────────
--
-- Three jobs in one table, and it is worth naming them separately because they
-- pull in different directions:
--
--   1. AUDIT — what we asked the bureau, when, on whose behalf, and what came
--      back. Written before the call, closed after it.
--   2. POPIA §71 EVIDENCE — the machine codes behind an automated decision, so
--      a data subject who asks "why" can be answered from a record rather than
--      from a reconstruction.
--   3. COST AND FOOTPRINT CONTROL — the cache that stops us paying twice, and
--      the unique index that stops two tabs billing the same person once each.
--
-- Every row is CREDIT INFORMATION about a natural person. Nothing here is ever
-- read by a patient or by practice staff.
--
-- ─── WHY AN ATTEMPT ROW EXISTS BEFORE THE CALL ─────────────────────────────
--
-- Experian bills per transaction, and a returned envelope means the
-- transaction was processed — including the envelopes that carry an error
-- code. If we only wrote a row on success, a timeout would leave us with a
-- possibly-billed call and no evidence of it, and the monthly invoice would be
-- unreconcilable. So the row is INSERTed first (completed_at NULL) and closed
-- afterwards. A row that never closes is exactly the artefact reconciliation
-- needs.
--
-- ─── THE IN-FLIGHT UNIQUE INDEX IS THE MONEY CONTROL ───────────────────────
--
-- bureau_enquiries_one_in_flight permits at most ONE open attempt per ID hash.
-- Two browser tabs, two serverless invocations, one billable call. This is the
-- half that actually holds: the in-process guard in lib/experian/assessment.ts
-- collapses re-entrant calls within a single Node instance, but serverless
-- gives no guarantee that two requests share an instance, so the application
-- guard is an optimisation and THIS is the constraint. Closing the attempt
-- (setting completed_at) releases it.
--
-- ─── WHY THE SCORE COLUMN CANNOT GO NEGATIVE ───────────────────────────────
--
-- Because a negative value from Experian is NOT a score. -1 is a thin file,
-- -2 is deceased, -3 sequestrated, -4 debt review, -5 dispute, -6 fraud. Code
-- that compares a raw value against a threshold turns "deceased" into
-- "declined for risk" — the wrong decision AND the wrong adverse-action
-- reason. Those values are warnings and belong in reason_codes as WARN-n; the
-- CHECK here means a regression that confuses the two fails at the database
-- rather than quietly filing a dead person under credit risk.
--
-- Legacy scorecards (NLR, CPA, CT, CU) use the opposite convention — a thin
-- file is a POSITIVE value below 480 — which is why the application must route
-- both through isRealScore() and never through a sign test. See
-- lib/experian/scores.ts.
--
-- ─── RLS: DENY BY DEFAULT, AND WHY THE REVOKE IS NOT REDUNDANT ─────────────
--
-- RLS is enabled with NO policies, so anon and authenticated have zero access
-- under RLS and the service role (which bypasses RLS) is the only writer —
-- the same posture as didit_webhook_events in 0102.
--
-- The REVOKE is belt to that braces and it is doing real work, not decoration:
-- Supabase grants table privileges to anon and authenticated by default, and
-- RLS-with-no-policies is the only thing standing between that grant and this
-- data. Removing the grant as well means a future migration that enables a
-- policy by accident, or disables RLS while debugging, does not immediately
-- publish every patient's credit file.
--
-- ─── RETENTION: NOT DECIDED, DELIBERATELY ──────────────────────────────────
--
-- TODO(retention): this table has NO retention rule yet, and that is a stated
-- gap rather than an oversight. It needs a decision that reconciles two
-- obligations pointing opposite ways:
--
--   • POPIA §14 — do not keep personal information longer than necessary for
--     the purpose it was collected for.
--   • NCA record-keeping — a credit provider must retain the records behind a
--     credit decision for a prescribed period, and §71 answerability requires
--     the reason codes to outlive the decision they explain.
--
-- raw_payload is the sharpest edge: it is the bureau's full response about a
-- person and is the first thing that should age out, plausibly well before the
-- decision columns do. Whoever takes this on should treat it as two retention
-- clocks, not one. Until then nothing is deleted, which is the conservative
-- direction for the audit obligation and the wrong direction for the privacy
-- one — an imbalance that should not be left standing indefinitely.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS bureau_enquiries (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE SET NULL, not CASCADE: a closed account does not erase the
  -- record that we made a billable enquiry, which is the audit fact.
  profile_id           UUID        REFERENCES profiles(id) ON DELETE SET NULL,

  -- The blind index from lib/idEncryption.ts's hashIdForLookup — the SAME
  -- helper profiles.sa_id_lookup_hash uses, deliberately not a second one.
  -- The plaintext ID is never written here; the encrypted copy already lives
  -- on profiles.sa_id_number.
  id_number_hash       TEXT        NOT NULL,

  provider             TEXT        NOT NULL DEFAULT 'experian',
  product              TEXT        NOT NULL DEFAULT 'person_get_score',

  -- Which pVersion was sent. Recorded per row because it is an environment
  -- variable that can change without a deploy, and a shift in the scorecard
  -- mix is otherwise indistinguishable from a shift in the applicant mix.
  p_version            TEXT        NOT NULL,

  requested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  latency_ms           INTEGER,

  outcome              TEXT,
  error_code           TEXT,

  -- Whether Experian will invoice for this. TRUE whenever an envelope came
  -- back, error envelopes included. A transport failure is recorded FALSE
  -- because no envelope arrived — but the row still exists, which is the
  -- point: "we cannot tell whether this billed" is itself the finding
  -- reconciliation needs, and an absent row would hide it.
  billed               BOOLEAN     NOT NULL DEFAULT FALSE,

  raw_payload          TEXT,
  results              JSONB,

  decision             TEXT,
  scorecard            TEXT,

  -- Positive scores only. See the header.
  score                INTEGER,
  risk_band            SMALLINT,
  risk_exposure_cents  INTEGER,

  -- Machine codes behind the decision, for §71. NEVER rendered to a patient:
  -- confirmed against real data, MI20 appeared on both a band-2 and a band-5
  -- file and MI39 on 46% of a 50-file sample including minimum-risk files.
  -- They describe the largest drag on a score, not the basis of a decision.
  reason_codes         TEXT[]      NOT NULL DEFAULT '{}',
  decision_detail      TEXT,

  CONSTRAINT bureau_enquiries_score_non_negative
    CHECK (score IS NULL OR score >= 0),
  CONSTRAINT bureau_enquiries_band_range
    CHECK (risk_band IS NULL OR risk_band BETWEEN 1 AND 5),
  CONSTRAINT bureau_enquiries_exposure_non_negative
    CHECK (risk_exposure_cents IS NULL OR risk_exposure_cents >= 0),
  -- The vocabulary is closed on purpose. These mirror ExperianOutcome['kind']
  -- and AssessmentDecision in lib/experian/; a value outside them means the
  -- application and this table have drifted, and failing the INSERT is a
  -- better outcome than an audit record nobody can interpret.
  CONSTRAINT bureau_enquiries_outcome_chk
    CHECK (outcome IS NULL OR outcome IN (
      'ok', 'thin_file', 'input_error', 'config_error', 'provider_error', 'transport_error'
    )),
  CONSTRAINT bureau_enquiries_decision_chk
    CHECK (decision IS NULL OR decision IN ('approved', 'declined', 'referred', 'error'))
);

-- The cache lookup: most recent enquiry for an ID hash.
CREATE INDEX IF NOT EXISTS bureau_enquiries_hash_requested_idx
  ON bureau_enquiries (id_number_hash, requested_at DESC);

-- Per-applicant history, for support and for §71 requests.
CREATE INDEX IF NOT EXISTS bureau_enquiries_profile_idx
  ON bureau_enquiries (profile_id, requested_at DESC)
  WHERE profile_id IS NOT NULL;

-- The double-billing guard. See the header — this is the half that holds.
CREATE UNIQUE INDEX IF NOT EXISTS bureau_enquiries_one_in_flight
  ON bureau_enquiries (id_number_hash)
  WHERE completed_at IS NULL;

ALTER TABLE bureau_enquiries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON bureau_enquiries FROM anon, authenticated;

COMMENT ON TABLE bureau_enquiries IS
  'Experian Person Get Score enquiry log. Credit information about a natural '
  'person — service-role access only, RLS enabled with no policies and the '
  'default anon/authenticated grants revoked. Rows are opened before the '
  'billable call and closed after it, so an unclosed row is evidence of a '
  'call whose billing status is unknown. Retention is NOT yet decided: see '
  'the TODO in migration 0148.';

COMMENT ON COLUMN bureau_enquiries.id_number_hash IS
  'HMAC-SHA256 blind index over the plaintext SA ID, from hashIdForLookup() — '
  'the same helper and key as profiles.sa_id_lookup_hash. The plaintext ID is '
  'never stored here.';

COMMENT ON COLUMN bureau_enquiries.billed IS
  'TRUE when an envelope came back, error envelopes included — Experian bills '
  'per processed transaction. FALSE for a transport failure, where no envelope '
  'arrived and the true billing status is unknowable from our side.';

COMMENT ON COLUMN bureau_enquiries.score IS
  'Positive scores only. A negative value from Experian is a warning code, not '
  'a low score (-2 is deceased); those are stored in reason_codes as WARN-n. '
  'The CHECK makes a regression that confuses the two fail loudly.';

COMMENT ON COLUMN bureau_enquiries.reason_codes IS
  'Machine codes backing the automated decision, retained for POPIA §71 '
  'requests. Never rendered verbatim to a data subject — they describe the '
  'largest drag on a score, not the basis of the decision, and adverse-action '
  'wording needs legal review before any of this reaches a patient.';

COMMENT ON INDEX bureau_enquiries_one_in_flight IS
  'At most one open enquiry per SA ID hash. The database half of the '
  'double-billing guard; lib/experian/assessment.ts holds the in-process half, '
  'which cannot span serverless invocations.';
