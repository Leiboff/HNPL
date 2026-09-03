-- ─── Exposure becomes the full originated value, held to completion ─────
--
-- REVERSING A DOCUMENTED DECISION, DELIBERATELY
--
-- 0130's header argues the opposite of this migration, in as many words:
-- "a customer three quarters of the way through a R10,000 plan has R2,500
-- of exposure, not R10,000, and charging them the full total would make
-- the limit far tighter than the number they were shown." That reasoning
-- is sound for a lender whose other obligations are visible.
--
-- It is not sound here. `Bureau_Expenses` is a snapshot taken at
-- assessment, and it cannot include obligations the patient takes on
-- afterwards — least of all plans with other BNPL providers, most of whom
-- do not report on the traditional monthly cadence. A declining-balance
-- limit lets a patient recycle the same headroom repeatedly inside one
-- assessment window against a bureau picture that never sees any of it.
--
-- So, by product decision: a plan consumes its FULL financed value for its
-- entire life and returns the whole amount in one step when it completes.
-- Two instalments into a three-instalment plan is exactly the same
-- headroom as day one. Partial payments free nothing.
--
-- ─── ONLY FOR PLANS ORIGINATED FROM HERE ON ────────────────────────────
--
-- `plans.full_value_exposure` discriminates. It defaults FALSE, so every
-- plan already in flight keeps the declining-balance arithmetic until it
-- completes and nobody's available balance moves overnight. The claim
-- function sets it TRUE on everything it writes from now on, and the two
-- rules coexist until the last legacy plan closes.
--
-- ─── WHAT RELEASES HEADROOM, AND WHAT DOES NOT ─────────────────────────
--
--   completed   releases in full — the point of the model
--   cancelled   releases in full — the plan never really originated
--   defaulted   HOLDS in full. The debt is still owed. (Such a patient is
--               separately frozen by lib/patient/freeze.ts, but the
--               exposure must not evaporate either way.)
--
-- A written-off INSTALMENT does not release anything either: the plan
-- stays live and holds its originated value. Releasing on write-off would
-- reward it.
--
-- ─── ONE DERIVATION, TWO CALLERS ───────────────────────────────────────
--
-- 0130 had this arithmetic written out twice in plpgsql — once in
-- claim_credit_for_plan and once in the deferred constraint trigger. That
-- is one copy too many: changing the model here would otherwise leave the
-- trigger enforcing the OLD invariant, so the two layers would disagree
-- about what a patient owes. Both now call patient_credit_exposure().
--
-- The TypeScript copy in lib/underwriting/creditLimit.ts stays a separate
-- implementation on purpose (0130's reasoning is unchanged: the optimistic
-- pre-read cannot take the lock), pinned against this one by test.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS full_value_exposure BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN plans.full_value_exposure IS
  'TRUE for plans originated under the full-value exposure model (0140): '
  'the plan holds its entire financed value against the limit until it '
  'completes or is cancelled. FALSE on every plan written before 0140, '
  'which keeps the declining-balance arithmetic from 0130 so no in-flight '
  'plan''s headroom changes retroactively.';

-- ── The single derivation ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION patient_credit_exposure(
  p_patient_id    UUID,
  p_exclude_plan  UUID DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(
    CASE
      -- Full value, for the plan's whole life. financed_amount is what
      -- HNPL actually lent; total_amount is the fallback for a row written
      -- before 0130 split the two.
      WHEN pl.full_value_exposure
        THEN COALESCE(pl.financed_amount, pl.total_amount, 0)
      -- Legacy: uncollected instalments less this plan's own excess while
      -- instalment 1 is still outstanding. Byte-for-byte the 0130 formula.
      ELSE pl.uncollected - pl.uncollected_excess
    END
  ), 0)
  FROM (
    SELECT
      p2.id,
      p2.full_value_exposure,
      p2.financed_amount,
      p2.total_amount,
      COALESCE(SUM(pay.amount) FILTER (WHERE pay.status <> 'collected'), 0) AS uncollected,
      CASE
        WHEN bool_or(pay.instalment_number = 1 AND pay.status <> 'collected')
          THEN COALESCE(p2.excess_amount, 0)
        ELSE 0
      END AS uncollected_excess
      FROM plans p2
      -- LEFT JOIN: a full-value plan counts even before its schedule
      -- exists, and must not vanish from the sum for want of payment rows.
      LEFT JOIN payments pay
        ON pay.plan_id = p2.id
       AND pay.kind    = 'instalment'
     WHERE p2.patient_id = p_patient_id
       AND (p_exclude_plan IS NULL OR p2.id <> p_exclude_plan)
       AND (
             -- A defaulted plan still holds its value under the new model.
             (p2.full_value_exposure
               AND p2.status IN ('pending_first_payment', 'active', 'defaulted'))
             -- Legacy plans keep exactly the 0130 status set.
          OR (NOT p2.full_value_exposure
               AND p2.status IN ('pending_first_payment', 'active'))
       )
     GROUP BY p2.id, p2.full_value_exposure, p2.financed_amount,
              p2.total_amount, p2.excess_amount
  ) AS pl;
$$;

COMMENT ON FUNCTION patient_credit_exposure(UUID, UUID) IS
  'A patient''s committed credit exposure. Full originated value for plans '
  'marked full_value_exposure (released only on completion or '
  'cancellation, held through default); the 0130 declining-balance formula '
  'for plans written before 0140. The single derivation used by both '
  'claim_credit_for_plan and the deferred exposure constraint, so the two '
  'layers cannot drift apart on what a patient owes.';

-- ── The claim, rebuilt on the shared derivation ───────────────────────

CREATE OR REPLACE FUNCTION claim_credit_for_plan(
  p_plan_id         UUID,
  p_patient_id      UUID,
  p_plan_type       INT,
  p_amounts         NUMERIC[],
  p_excess          NUMERIC,
  p_due_dates       DATE[],
  p_expected_status TEXT,
  p_terms_version   TEXT,
  p_privacy_version TEXT
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_min_financed  CONSTANT NUMERIC := 300;

  v_limit         NUMERIC;
  v_total         NUMERIC;
  v_status        TEXT;
  v_outstanding   NUMERIC := 0;
  v_available     NUMERIC;
  v_sum           NUMERIC;
  v_financed      NUMERIC;
  v_survivors     INT;
  v_i             INT;
  v_assessment    UUID;
  v_completed     INT;
  v_live          INT;
  v_defaulted     INT;
BEGIN
  IF p_plan_type NOT IN (2, 3) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'plan_not_found');
  END IF;
  IF array_length(p_amounts, 1) IS DISTINCT FROM p_plan_type
     OR array_length(p_due_dates, 1) IS DISTINCT FROM p_plan_type THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amounts_mismatch');
  END IF;

  -- ── 1. THE LOCK ──────────────────────────────────────────────────────
  SELECT approved_credit_limit, current_credit_assessment_id
    INTO v_limit, v_assessment
    FROM profiles
   WHERE id = p_patient_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'plan_not_found');
  END IF;
  IF v_limit IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_limit');
  END IF;

  -- ── 2. Ownership and expected state ──────────────────────────────────
  SELECT total_amount, status
    INTO v_total, v_status
    FROM plans
   WHERE id = p_plan_id
     AND patient_id = p_patient_id;

  IF NOT FOUND OR v_status IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('ok', false, 'error', 'plan_not_found');
  END IF;

  -- ── 2b. First-timer concurrency, UNDER THE LOCK ──────────────────────
  --
  -- A patient who has never COMPLETED a plan may hold only one at a time,
  -- regardless of headroom. app/patient/actions.ts checks this too, for a
  -- friendlier message earlier — but that check is a read outside any
  -- lock, which is precisely the shape A-04 showed to be vacuous: two
  -- concurrent acceptances both see no live plan and both proceed.
  --
  -- Gated on COMPLETED plans specifically. Reaching a terminal state that
  -- is not completion does not earn the multi-plan privilege.
  SELECT COUNT(*) FILTER (WHERE status = 'completed'),
         COUNT(*) FILTER (WHERE status IN ('pending_first_payment', 'active')
                            AND id <> p_plan_id),
         COUNT(*) FILTER (WHERE status = 'defaulted')
    INTO v_completed, v_live, v_defaulted
    FROM plans
   WHERE patient_id = p_patient_id;

  -- ── A prior default, before ever completing a plan ───────────────────
  --
  -- Blocked pending review rather than merely kept at one plan. The
  -- patient's only track record is a default, so there is nothing to lend
  -- against and no reason to believe a second plan ends differently.
  --
  -- Scoped to v_completed = 0 deliberately: a default on a patient who HAS
  -- completed plans is the general freeze's business
  -- (lib/patient/freeze.ts), which lifts when the debt is settled. This
  -- one does not lift on its own.
  --
  -- A CANCELLED first plan deliberately does NOT land here. A cancellation
  -- means the plan never really originated — which is also why it releases
  -- its headroom in full — and blocking on it would punish patients for
  -- practice-side cancellations. Such a patient simply remains a
  -- first-timer, held to one plan at a time by the rule below.
  IF v_completed = 0 AND v_defaulted > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'prior_default_review');
  END IF;

  IF v_completed = 0 AND v_live > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'first_plan_in_progress');
  END IF;

  -- ── 3. The caller's split has to reconcile ───────────────────────────
  SELECT COALESCE(SUM(a), 0) INTO v_sum FROM unnest(p_amounts) AS a;

  IF ROUND(v_sum, 2) IS DISTINCT FROM ROUND(v_total, 2) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amounts_mismatch');
  END IF;
  IF p_excess IS NULL OR p_excess < 0 OR ROUND(p_excess, 2) > ROUND(v_total, 2) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amounts_mismatch');
  END IF;

  IF ROUND(p_amounts[1], 2) < ROUND(p_excess, 2) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'excess_misplaced');
  END IF;
  FOR v_i IN 2 .. p_plan_type LOOP
    IF ROUND(p_amounts[v_i], 2) IS DISTINCT FROM ROUND(p_amounts[2], 2) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'excess_misplaced');
    END IF;
    IF p_amounts[v_i] < 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'amounts_mismatch');
    END IF;
  END LOOP;

  v_financed := ROUND(v_total - p_excess, 2);

  -- ── 4. Exposure, from the one shared derivation ──────────────────────
  v_outstanding := patient_credit_exposure(p_patient_id, p_plan_id);
  v_available   := ROUND(v_limit - v_outstanding, 2);

  IF v_financed > v_available THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'over_limit',
      'available', v_available, 'requested', v_financed);
  END IF;
  IF v_financed < c_min_financed THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'below_minimum',
      'available', v_available, 'minimum', c_min_financed);
  END IF;

  -- ── 5. Write ─────────────────────────────────────────────────────────
  DELETE FROM payments
   WHERE plan_id = p_plan_id
     AND status IN ('scheduled', 'processing', 'failed');

  SELECT COUNT(*) INTO v_survivors FROM payments WHERE plan_id = p_plan_id;
  IF v_survivors > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'schedule_survived');
  END IF;

  UPDATE plans
     SET status               = 'pending_first_payment',
         plan_type            = p_plan_type,
         instalment_amount    = p_amounts[1],
         financed_amount      = v_financed,
         excess_amount        = ROUND(p_excess, 2),
         -- Everything written from here on uses the new model.
         full_value_exposure  = TRUE,
         -- Stamped under the same lock that read it, so a plan can always
         -- be traced to the assessment whose limit authorised it.
         credit_assessment_id = v_assessment,
         terms_accepted_at    = now(),
         terms_version        = p_terms_version,
         privacy_version      = p_privacy_version
   WHERE id = p_plan_id
     AND patient_id = p_patient_id
     AND status = p_expected_status;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'plan_not_found');
  END IF;

  FOR v_i IN 1 .. p_plan_type LOOP
    INSERT INTO payments (
      id, plan_id, patient_id, instalment_number, amount, due_date, status, kind
    ) VALUES (
      gen_random_uuid(), p_plan_id, p_patient_id, v_i,
      p_amounts[v_i], p_due_dates[v_i],
      CASE WHEN v_i = 1 THEN 'processing' ELSE 'scheduled' END,
      'instalment'
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'financed', v_financed,
    'excess', ROUND(p_excess, 2),
    'available_before', v_available,
    'instalment_one_id', (
      SELECT id FROM payments
       WHERE plan_id = p_plan_id AND kind = 'instalment' AND instalment_number = 1
    )
  );
END;
$$;

-- ── The deferred invariant, on the same derivation ────────────────────
--
-- Updated in the SAME migration as the claim. Leaving it on the old
-- formula would mean the constraint that exists to catch an application
-- mistake was itself enforcing a different definition of exposure than the
-- code it guards.

CREATE OR REPLACE FUNCTION enforce_credit_exposure()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_patient   UUID := COALESCE(NEW.patient_id, OLD.patient_id);
  v_limit     NUMERIC;
  v_exposure  NUMERIC;
BEGIN
  IF v_patient IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT approved_credit_limit INTO v_limit FROM profiles WHERE id = v_patient;
  IF v_limit IS NULL THEN
    RETURN NULL;   -- not this trigger's decision to make; see 0130
  END IF;

  v_exposure := patient_credit_exposure(v_patient, NULL);

  IF ROUND(v_exposure, 2) > ROUND(v_limit, 2) THEN
    RAISE EXCEPTION
      'credit exposure %.2f exceeds the approved limit %.2f for this customer '
      '(audit A-04) — the schedule was not written',
      v_exposure, v_limit;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION enforce_credit_exposure() IS
  'Deferred constraint trigger: at COMMIT, a patient''s committed exposure '
  'may not exceed profiles.approved_credit_limit. Shares '
  'patient_credit_exposure() with claim_credit_for_plan so the invariant '
  'and the procedure cannot disagree. Silent for a patient with no '
  'approved limit.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION patient_credit_exposure(UUID, UUID) TO service_role;
  END IF;
END $$;
REVOKE ALL ON FUNCTION patient_credit_exposure(UUID, UUID) FROM PUBLIC;
