-- ─── The credit decision and the schedule become one transaction ────────
--
-- THE DEFECT (audit 2026-09-02, A-04)
--
-- `checkCreditLimit` reads the approved limit, sums outstanding exposure,
-- compares, and returns. The write that commits the new exposure happens
-- afterwards, in the caller. Between them: no row lock, no serialisable
-- transaction, and — the layer that would have caught it regardless — no
-- database constraint relating `payments` in aggregate to
-- `profiles.approved_credit_limit`.
--
-- So two requests that overlap both see the pre-write exposure, both find
-- headroom, and both proceed. Proved in
-- lib/underwriting/creditLimit.race.adversarial.test.ts: five concurrent
-- checks against a R5,000 limit all return ok, and R25,000 of exposure
-- commits. No timing precision needed — two browser tabs and two clicks
-- inside the same second, or a `Promise.all` from a console.
--
-- It is worth being clear about where this came from: the previous audit's
-- F-10 fix was right that nothing enforced the limit, and the enforcement it
-- added is correct sequentially and vacuous concurrently. A check-then-act is
-- not an enforcement mechanism.
--
-- ─── THE FIX ───────────────────────────────────────────────────────────
--
-- One SECURITY DEFINER function that locks, decides and writes, on the
-- pattern `claim_plan_for_settlement` (0058/0080) already established here:
--
--   1. SELECT … FROM profiles WHERE id = p_patient_id FOR UPDATE
--      The lock. Two concurrent claims for the same patient serialise on
--      this row; the second one sees the first one's schedule.
--   2. Verify plan ownership and that its status is what the caller expected.
--   3. Re-derive outstanding exposure from `payments`.
--   4. Decide, and refuse with a coded string rather than an exception, so
--      the caller can map it to copy.
--   5. Write the plan transition and the schedule.
--
-- Plus a DEFERRED constraint trigger (section 3) so an application-layer
-- mistake cannot reopen it even if someone bypasses this function.
--
-- ─── WHY THE CALLER PASSES THE AMOUNTS IN ──────────────────────────────
--
-- `lib/finance.ts` is the one place this project computes money, it is pure,
-- and it is tested against known answers. Reimplementing
-- `splitInstalmentsWithExcess` in plpgsql would give this system two
-- definitions of a customer's schedule that could drift by a cent — and
-- lib/finance.ts's own header says never to reimplement it inline.
--
-- So the caller computes the split and passes it; this function VALIDATES it
-- under the lock, which is a comparison rather than a second implementation:
--
--   • the amounts must sum to `plans.total_amount` — so a caller cannot
--     understate the bill to fit the allowance
--   • `p_excess` must equal `total - financed`, and the whole excess must sit
--     on instalment 1 — the property that bounds HNPL's exposure to the
--     allowance once instalment 1 clears
--   • `financed` (= total − excess) must fit the headroom this function
--     computed for itself, from the database, under the lock
--
-- A caller that lies about any of those is refused. That is the difference
-- between passing data in and trusting it.
--
-- ─── THE ALLOWANCE MODEL (product decision, audit A-05) ────────────────
--
-- A bill above the customer's remaining allowance is restructured, not
-- refused: HNPL finances what it can, and the rest is collected on
-- instalment 1 from the customer's card before the plan activates.
-- Allowance R15,000, bill R30,000, 3 instalments → R20,000 / R5,000 / R5,000.
-- The practice is still paid 94% of the gross; `calculateFee` is untouched.
--
-- ─── EXPOSURE IS THE FINANCED PART, NOT THE UNCOLLECTED TOTAL ──────────
--
-- With an excess on instalment 1, "uncollected instalments" overstates what
-- HNPL is actually carrying: the excess is the customer's own money in
-- flight, not credit. So exposure per live plan is
--
--     uncollected instalments − (that plan's excess, if instalment 1 is still uncollected)
--
-- `plans.excess_amount` defaults to 0, so for every plan written before this
-- migration the formula reduces exactly to the previous one and no existing
-- plan's exposure changes.

-- ── 1. Where the split is recorded ─────────────────────────────────────
--
-- Both halves, not one derived from the other. `total_amount` minus
-- `excess_amount` would give `financed_amount` today, but a plan is a
-- financial record and a reader should not have to know the model's
-- arithmetic to read what HNPL lent.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS financed_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS excess_amount   NUMERIC(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN plans.financed_amount IS
  'The part of total_amount HNPL is lending, capped at the customer''s '
  'remaining allowance at acceptance. NULL on plans written before 0130 and '
  'on plans still at pending_acceptance. See audit A-05.';
COMMENT ON COLUMN plans.excess_amount IS
  'total_amount - financed_amount: the part collected up front on instalment '
  '1 because it exceeded the allowance. Zero on every plan that fitted, and '
  'on every plan written before 0130 — which is why the exposure query in '
  'claim_credit_for_plan reduces to the old one for those.';

-- ── 2. The atomic claim ────────────────────────────────────────────────
--
-- Returns one of:
--   { ok: true,  financed, excess, available_before }
--   { ok: false, error: 'plan_not_found' }        wrong id, wrong owner, or
--                                                 not in the expected status
--   { ok: false, error: 'no_limit' }              no approved allowance yet
--   { ok: false, error: 'amounts_mismatch' }      caller's split does not
--                                                 reconcile to total_amount
--   { ok: false, error: 'excess_misplaced' }      excess not wholly on
--                                                 instalment 1
--   { ok: false, error: 'over_limit', available }  financed exceeds headroom
--   { ok: false, error: 'below_minimum', available } nothing worth financing
--   { ok: false, error: 'schedule_survived' }     stale rows the caller must
--                                                 not silently overwrite

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
  -- R300. The floor below which a "payment plan" is a card payment wearing a
  -- plan's clothes: instalments 2 and 3 round to a few rand and the customer
  -- is charged almost everything up front. Mirrors MIN_FINANCED_RANDS in
  -- lib/finance.ts, and 0130_claim_credit_for_plan.rpc.test.ts asserts the
  -- two agree so this copy cannot drift.
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
BEGIN
  IF p_plan_type NOT IN (2, 3) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'plan_not_found');
  END IF;
  IF array_length(p_amounts, 1) IS DISTINCT FROM p_plan_type
     OR array_length(p_due_dates, 1) IS DISTINCT FROM p_plan_type THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amounts_mismatch');
  END IF;

  -- ── 1. THE LOCK ──────────────────────────────────────────────────────
  -- Taken before anything is read about exposure, and held to COMMIT. This
  -- single line is what turns A-04's check-then-act into a decision.
  SELECT approved_credit_limit
    INTO v_limit
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

  -- ── 3. The caller's split has to reconcile ───────────────────────────
  SELECT COALESCE(SUM(a), 0) INTO v_sum FROM unnest(p_amounts) AS a;

  IF ROUND(v_sum, 2) IS DISTINCT FROM ROUND(v_total, 2) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amounts_mismatch');
  END IF;
  IF p_excess IS NULL OR p_excess < 0 OR ROUND(p_excess, 2) > ROUND(v_total, 2) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amounts_mismatch');
  END IF;

  -- The excess must sit ENTIRELY on instalment 1. Checked structurally
  -- rather than taken on trust: instalment 1 must be at least the excess,
  -- and instalments 2..n must be equal to each other (the financed part
  -- split evenly), which together admit only the intended shape.
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

  -- ── 4. Exposure, re-derived here rather than passed in ───────────────
  -- Uncollected instalments across the patient's other LIVE plans, less each
  -- of those plans' own uncollected excess (see the header: the excess is
  -- the customer's money in flight, not credit).
  SELECT COALESCE(SUM(per_plan.uncollected - per_plan.uncollected_excess), 0)
    INTO v_outstanding
    FROM (
      SELECT
        pl.id,
        COALESCE(SUM(pay.amount), 0) AS uncollected,
        CASE
          WHEN bool_or(pay.instalment_number = 1) THEN COALESCE(pl.excess_amount, 0)
          ELSE 0
        END AS uncollected_excess
        FROM plans pl
        JOIN payments pay
          ON pay.plan_id = pl.id
         AND pay.kind    = 'instalment'
         AND pay.status <> 'collected'
       WHERE pl.patient_id = p_patient_id
         AND pl.status IN ('pending_first_payment', 'active')
         AND pl.id <> p_plan_id
       GROUP BY pl.id, pl.excess_amount
    ) AS per_plan;

  v_available := ROUND(v_limit - v_outstanding, 2);

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
  --
  -- Stale rows first, scoped to statuses that cannot represent a charge that
  -- landed — the F-06 lesson. 'processing' is included because it is the
  -- status initiateCheckout itself writes for instalment 1, so every genuine
  -- abandoner sits in it; what makes that safe is the caller's own
  -- peach_registration_id check before it gets here, plus the survivor count
  -- below.
  DELETE FROM payments
   WHERE plan_id = p_plan_id
     AND status IN ('scheduled', 'processing', 'failed');

  SELECT COUNT(*) INTO v_survivors FROM payments WHERE plan_id = p_plan_id;
  IF v_survivors > 0 THEN
    -- Something collected, defaulted or written-off is still here. Refuse
    -- rather than write a second schedule alongside it.
    RETURN jsonb_build_object('ok', false, 'error', 'schedule_survived');
  END IF;

  UPDATE plans
     SET status            = 'pending_first_payment',
         plan_type         = p_plan_type,
         instalment_amount = p_amounts[1],
         financed_amount   = v_financed,
         excess_amount     = ROUND(p_excess, 2),
         terms_accepted_at = now(),
         terms_version     = p_terms_version,
         privacy_version   = p_privacy_version
   WHERE id = p_plan_id
     AND patient_id = p_patient_id
     AND status = p_expected_status;

  IF NOT FOUND THEN
    -- Cannot happen under the lock, but a claim that silently wrote nothing
    -- would be the worst possible outcome here.
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

COMMENT ON FUNCTION claim_credit_for_plan(UUID, UUID, INT, NUMERIC[], NUMERIC, DATE[], TEXT, TEXT, TEXT) IS
  'Atomic credit claim: locks the patient''s profile row, re-derives '
  'outstanding exposure, validates the caller''s instalment split against '
  'total_amount and the remaining allowance, and writes the plan transition '
  'plus the schedule — all in one transaction. Replaces the checkCreditLimit '
  'read-then-write sequence that A-04 showed was vacuous under concurrency. '
  'The caller supplies the amounts because lib/finance.ts is the one place '
  'this project computes money; this function validates them rather than '
  'recomputing them.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION
      claim_credit_for_plan(UUID, UUID, INT, NUMERIC[], NUMERIC, DATE[], TEXT, TEXT, TEXT)
      TO service_role;
  END IF;
END $$;
REVOKE ALL ON FUNCTION
  claim_credit_for_plan(UUID, UUID, INT, NUMERIC[], NUMERIC, DATE[], TEXT, TEXT, TEXT)
  FROM PUBLIC;

-- ── 3. The database-level invariant ────────────────────────────────────
--
-- The claim above is correct. This is the layer that holds when the
-- application layer is wrong — the same reasoning 0121 used for the UNIQUE
-- index on (plan_id, instalment_number), and the reason A-04 was possible at
-- all: there was no invariant, only a procedure.
--
-- DEFERRABLE INITIALLY DEFERRED is load-bearing. A legitimate schedule is
-- two or three INSERTs, and a row-by-row check would fire after the first
-- one and see a half-written plan. Deferring to COMMIT evaluates the
-- transaction as a whole, which is the only point at which "this patient's
-- exposure" is a meaningful quantity.
--
-- It intentionally does NOT fire for a patient with no approved limit: that
-- is `claim_credit_for_plan`'s 'no_limit' refusal to make, and a constraint
-- that blocked every write for such a patient would break the paths that
-- legitimately touch their rows (a webhook marking an old instalment
-- collected, for instance).

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
    RETURN NULL;   -- see the header: not this trigger's decision to make
  END IF;

  SELECT COALESCE(SUM(per_plan.uncollected - per_plan.uncollected_excess), 0)
    INTO v_exposure
    FROM (
      SELECT
        pl.id,
        COALESCE(SUM(pay.amount), 0) AS uncollected,
        CASE
          WHEN bool_or(pay.instalment_number = 1) THEN COALESCE(pl.excess_amount, 0)
          ELSE 0
        END AS uncollected_excess
        FROM plans pl
        JOIN payments pay
          ON pay.plan_id = pl.id
         AND pay.kind    = 'instalment'
         AND pay.status <> 'collected'
       WHERE pl.patient_id = v_patient
         AND pl.status IN ('pending_first_payment', 'active')
       GROUP BY pl.id, pl.excess_amount
    ) AS per_plan;

  IF ROUND(v_exposure, 2) > ROUND(v_limit, 2) THEN
    RAISE EXCEPTION
      'credit exposure %.2f exceeds the approved limit %.2f for this customer '
      '(audit A-04) — the schedule was not written',
      v_exposure, v_limit;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_credit_exposure ON payments;
CREATE CONSTRAINT TRIGGER trg_enforce_credit_exposure
  AFTER INSERT OR UPDATE ON payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_credit_exposure();

COMMENT ON FUNCTION enforce_credit_exposure() IS
  'Deferred constraint trigger: at COMMIT, a patient''s uncollected financed '
  'exposure across live plans may not exceed profiles.approved_credit_limit. '
  'The invariant behind claim_credit_for_plan, so an application-layer '
  'mistake cannot reopen A-04. Silent for a patient with no approved limit — '
  'that refusal belongs to the claim function.';
