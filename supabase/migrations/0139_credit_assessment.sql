-- ─── Credit assessment: the standing limit and its immutable history ────
--
-- Two separate concerns, deliberately not one table:
--
--   • `profiles`            CURRENT STATE. What the patient's limit is
--                           right now, when it was assessed, and whether
--                           they are inside a decline cooldown. Mutable.
--
--   • `credit_assessments`  HISTORY. One row per assessment, approved AND
--                           declined, never updated and never deleted. A
--                           re-assessment writes a NEW row, so the way a
--                           patient's limit moved over time — and what
--                           drove each move — stays readable.
--
-- ─── WHY DECLINES ARE STORED AT ALL ────────────────────────────────────
--
-- Without them the only population visible at calibration time is the one
-- we already said yes to, and every coefficient gets tuned on a censored
-- sample. The whole point of this schema is to recalibrate at a few
-- hundred outcomes, which cannot be done from approvals alone.
--
-- Hence also `plans.credit_assessment_id`: a plan traces back to the exact
-- assessment that authorised it, so limits can be joined to plan
-- performance without guessing from timestamps.
--
-- ─── WHY EXPERIAN'S OWN DISPOSABLE INCOME IS KEPT UNMODIFIED ───────────
--
-- `experian_disposable_income` sits beside our `computed_ndi` rather than
-- being replaced by it. If a cohort goes bad we need to be able to ask
-- whether the bureau saw it coming and our overlay masked it. Storing only
-- the adjusted figure makes that question unanswerable.
--
-- ─── PENDING IS A FIRST-CLASS OUTCOME ──────────────────────────────────
--
-- `outcome` has three values, not two. A SOAP fault, a timeout, a -205 or
-- a -106 means we could not get an answer — that is not a refusal, it must
-- not put the applicant into the cooldown, and the patient must not be
-- told they were declined. Keeping it distinct in the DATA is what stops a
-- later reporting query from quietly counting outages as rejections.

-- ── 1. Current state on the patient record ────────────────────────────

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS scorecard_band                TEXT,
  ADD COLUMN IF NOT EXISTS last_score_snapshot           JSONB,
  ADD COLUMN IF NOT EXISTS credit_assessment_status      TEXT,
  ADD COLUMN IF NOT EXISTS credit_decline_cooldown_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_credit_assessment_id  UUID;

-- `assessed_at` is deliberately NOT a new column: profiles.credit_check_completed_at
-- (0066) already means exactly that and is already written by the
-- affordability step. A second timestamp with the same meaning is how two
-- staleness answers start disagreeing.
COMMENT ON COLUMN profiles.credit_check_completed_at IS
  'When the current limit was assessed. Staleness is measured from here '
  '(CREDIT_STALENESS_MONTHS, default 6). Past that window a new plan '
  'request triggers RE-ASSESSMENT before approval — never a decline.';

COMMENT ON COLUMN profiles.last_score_snapshot IS
  'The score result currently in force: raw value, deciding scorecard, '
  'band, family, and every card the bureau returned. Carried here because '
  'the assessment runs in TWO requests — the score at the identity step, '
  'the pricing at the affordability step — and credit_assessments is '
  'append-only, so the pricing row cannot be an update of the score row. '
  'Without it a completed assessment would either be split across two '
  'rows or lose its score fields entirely, and the whole table exists to '
  'be joined on exactly those.';

COMMENT ON COLUMN profiles.scorecard_band IS
  'Band of the assessment currently in force: minimum / low / average / '
  'thin_file. high and very_high are decline bands and never persist here '
  'as an active state.';

COMMENT ON COLUMN profiles.credit_assessment_status IS
  'Lifecycle of the standing limit: active / expired / declined / pending. '
  'Distinct from credit_check_status (0066), which is the ONBOARDING STEP '
  'flag read by lib/onboarding/state.ts and constrained to '
  'pending/passed/failed. This column carries the states that flag cannot '
  'express — notably expired (re-assess, do not refuse) and pending (we '
  'could not reach the bureau, which is also not a refusal).';

COMMENT ON COLUMN profiles.credit_decline_cooldown_until IS
  'Set only on a SUBSTANTIVE decline. A pending assessment must never set '
  'it. Matched on the ID number rather than email or phone, so a declined '
  'applicant cannot buy a fresh billable enquiry by re-registering with '
  'new contact details.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_credit_assessment_status_chk'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_credit_assessment_status_chk
      CHECK (
        credit_assessment_status IS NULL
        OR credit_assessment_status IN ('active', 'expired', 'declined', 'pending')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_scorecard_band_chk'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_scorecard_band_chk
      CHECK (
        scorecard_band IS NULL
        OR scorecard_band IN ('minimum', 'low', 'average', 'high', 'very_high', 'thin_file')
      );
  END IF;
END $$;

-- No column-lock migration is needed for any of the above. 0122 inverted
-- protect_profiles_columns() to an ALLOW-LIST compared over to_jsonb(NEW)
-- vs to_jsonb(OLD), so a column added later is locked to patient writes BY
-- DEFAULT. That inversion exists precisely so this file does not have to
-- remember to lock them.

-- ── 2. The immutable log ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS credit_assessments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Cooldown matching is on the ID, not the account: the same person
  -- re-registering with a new email must hit the same cooldown. Stores the
  -- blind index (lib/idEncryption.ts hashIdForLookup), never the ID.
  sa_id_lookup_hash TEXT,

  -- What caused this assessment to run.
  trigger      TEXT NOT NULL
    CHECK (trigger IN ('signup', 'staleness', 'increase_request', 'admin')),

  -- Three outcomes. See the header on why pending is not a decline.
  outcome      TEXT NOT NULL
    CHECK (outcome IN ('approved', 'declined', 'pending')),

  -- Which gate ended it. NULL on an approval.
  failed_gate  TEXT
    CHECK (failed_gate IS NULL OR failed_gate IN ('score', 'identity', 'affordability', 'limit')),

  -- Substantive refusals only. NULL unless outcome = 'declined'.
  decline_reason TEXT
    CHECK (decline_reason IS NULL OR decline_reason IN (
      'band', 'deceased', 'sequestrated', 'debt_review', 'fraud',
      'identity_mismatch', 'below_minimum'
    )),

  -- Why we could not answer. NULL unless outcome = 'pending'.
  pending_reason TEXT,

  -- ── Score stage ─────────────────────────────────────────────────────
  score_value      INTEGER,
  score_result_type TEXT,
  score_family     TEXT,
  scorecard_band   TEXT,
  -- Every card the bureau returned, not just the deciding one: the
  -- captured applicant is unscorable on SU and Low Risk on STS, and that
  -- pair is exactly what calibration needs to see.
  score_results    JSONB,

  -- ── Affordability stage (Experian's figures, unmodified) ────────────
  gmip_value                 NUMERIC(12,2),
  gmip_confidence_level      TEXT,
  gmip_band                  TEXT,
  bureau_expenses            NUMERIC(12,2),
  calc_living_expenses       NUMERIC(12,2),
  experian_disposable_income NUMERIC(12,2),
  enq_id                     TEXT,
  thin_file_reason           TEXT,

  -- ── Our overlay ─────────────────────────────────────────────────────
  computed_net      NUMERIC(12,2),
  computed_living   NUMERIC(12,2),
  computed_ndi      NUMERIC(12,2),
  computed_monthly  NUMERIC(12,2),
  computed_facility NUMERIC(12,2),
  final_limit       NUMERIC(12,2),

  -- Which of the four constraints produced the number.
  binding_constraint TEXT
    CHECK (binding_constraint IS NULL OR binding_constraint IN (
      'formula', 'band_ceiling', 'income_cap', 'scorecard_cap', 'minimum'
    )),

  -- The deciding scorecard's own cap, when it had one. Kept apart from
  -- the band ceiling on purpose: Sigma Transcend is capped at R1,000
  -- because a Low Risk on the thin-file card is not the evidence a Low
  -- Risk on the unsecured-credit card is, and the two must stay
  -- distinguishable. Counting how often this is the binding constraint is
  -- what will justify relaxing it later — or keeping it.
  scorecard_cap NUMERIC(12,2),

  -- Stored for calibration whether or not it moved the limit. It can only
  -- ever have lowered it.
  declared_income NUMERIC(12,2),

  -- Which coefficient set priced this. Without it the whole table is
  -- uninterpretable the first time a rate changes.
  coefficient_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS credit_assessments_patient_idx
  ON credit_assessments (patient_id, created_at DESC);

-- Cooldown lookups are by ID hash and recency, for an applicant who may
-- have no account yet under this email.
CREATE INDEX IF NOT EXISTS credit_assessments_id_hash_idx
  ON credit_assessments (sa_id_lookup_hash, created_at DESC)
  WHERE sa_id_lookup_hash IS NOT NULL;

-- ── 3. Append-only, enforced ──────────────────────────────────────────
--
-- "Never overwrite a log row" as a constraint rather than a convention.
-- A re-assessment writes a new row; nothing edits an old one. Without this
-- the history silently becomes last-write-wins the first time someone
-- writes an UPDATE against it.

CREATE OR REPLACE FUNCTION credit_assessments_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'credit_assessments is append-only (attempted %). A re-assessment '
    'writes a NEW row — the history is what makes the limits calibratable.',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS credit_assessments_no_update ON credit_assessments;
CREATE TRIGGER credit_assessments_no_update
  BEFORE UPDATE OR DELETE ON credit_assessments
  FOR EACH ROW EXECUTE FUNCTION credit_assessments_append_only();

-- ── 4. RLS ────────────────────────────────────────────────────────────
--
-- Enabled with NO policies — the same posture as peach_webhook_events
-- (0123) and didit_webhook_events (0102). The only writer is server-side
-- code on the service-role client, which bypasses RLS.
--
-- Deliberately unreadable by the patient's own session: these rows carry
-- predicted income, bureau expenses and disposable income. None of that
-- may reach a client payload, and the surest way to guarantee that is for
-- the anon key to have no path to the table at all.

ALTER TABLE credit_assessments ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE credit_assessments IS
  'Immutable per-assessment log, approved and declined alike. Append-only '
  'by trigger; RLS on with no policies (service-role only) because the '
  'rows carry income figures that must never reach a client payload. '
  'Joined to plan performance via plans.credit_assessment_id.';

-- ── 5. Plan traceability ──────────────────────────────────────────────

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS credit_assessment_id UUID
    REFERENCES credit_assessments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS plans_credit_assessment_idx
  ON plans (credit_assessment_id)
  WHERE credit_assessment_id IS NOT NULL;

COMMENT ON COLUMN plans.credit_assessment_id IS
  'The assessment whose limit authorised this plan. NULL on plans written '
  'before 0139 and on plans authorised by the pre-assessment stub limit. '
  'This is the join calibration needs: limit priced -> plan performance.';

-- Now that the table exists, point the profile at it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_current_credit_assessment_fk'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_current_credit_assessment_fk
      FOREIGN KEY (current_credit_assessment_id)
      REFERENCES credit_assessments(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN profiles.current_credit_assessment_id IS
  'The assessment row that produced the limit currently in force. The '
  'limit itself stays denormalised on approved_credit_limit because the '
  'claim RPC reads it under a row lock on this table.';
