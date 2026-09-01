-- ─── A claim that dies mid-flight is now findable and reversible ───────────
--
-- THE DEFECT (audit 2026-09-02, A-13)
--
-- "Settle entire bill" flips every outstanding instalment to 'processing'
-- with settled_by_payment_id set, then calls the provider. Three outcomes,
-- handled three ways:
--
--   rejected  → failSettlementRow, and the webhook reverts each covered row
--               from its snapshot. Correct.
--   success   → the webhook collects them. Correct.
--   error     → the action returns transport_error and leaves EVERYTHING in
--               'processing'.
--
-- The comment on that branch says the row is left for reconciliation. Nothing
-- reconciled it. attemptChargeInstalment claims only scheduled/failed/
-- defaulted; the collection cron selects only scheduled and failed;
-- assessDunningFee looks only at failed. A 'processing' instalment with no
-- live provider reference is invisible to every automated path, permanently —
-- so one transport error silently writes off a plan's whole remaining
-- balance, and it never defaults, so isPatientFrozen never fires either.
--
-- Three other paths can strand a claim the same way: initiateCheckout's
-- instalment 1, payWithSavedCard's, and the collection cron's own claim.
--
-- ─── WHAT THIS MIGRATION ADDS, AND WHY IT IS A TRIGGER ─────────────────────
--
-- A sweep needs three facts about a stranded row, and two of them nothing
-- recorded:
--
--   processing_since   WHEN it entered 'processing'. payments has no
--                      updated_at, so "stuck for more than N hours" was not
--                      a question the table could answer at all.
--   pre_claim_status   WHAT it was before the claim, so a revert restores the
--                      truth rather than guessing. chargeInstalment held this
--                      in a local variable — which is precisely the thing a
--                      process that dies mid-flight loses.
--
-- Both are maintained by a trigger rather than by the four call sites that
-- claim rows, because "the code path that forgot" is the failure mode this
-- whole finding is about. A fifth claimer written next year inherits them.
--
-- The third fact CANNOT be a trigger:
--
--   provider_attempted_at  whether the charge was actually handed to Peach.
--                          The database cannot know that; only the code
--                          about to make the HTTP call does. It is stamped
--                          immediately BEFORE the call, so it means "may be
--                          in flight", never "succeeded".
--
-- ─── WHY THAT THIRD COLUMN DECIDES WHETHER A SWEEP MAY REVERT ──────────────
--
-- The existing transport-error comment is right and the audit's suggested
-- fix — revert like the rejected branch does — is not safe on its own: a
-- transport error means we do not know whether Peach got the charge, and
-- reverting a claim Peach is about to collect risks charging the customer
-- twice. This client has no endpoint to ask (the recurring surface exposes
-- no payment-status query), so no sweep can resolve that question by itself.
--
-- provider_attempted_at splits the population into the two answers that are
-- actually available:
--
--   NULL      nothing was ever sent. The claim died before the call — a
--             crashed process, a failed precondition lookup, a lambda that
--             timed out between the UPDATE and the fetch. There is no charge
--             to double, so reverting is unconditionally safe.
--   NOT NULL  a charge may be in flight. Never auto-reverted. Reported, and
--             surfaced for a human to reconcile against the Peach dashboard —
--             which is the only place that answer exists.
--
-- The first case is the majority and is now self-healing. The second is now
-- visible instead of silent, which is the actual defect: an operator with a
-- list of four rows to check is a working control; an invisible write-off is
-- not.

-- ── 1. The columns ─────────────────────────────────────────────────────────

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS processing_since      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_claim_status      TEXT,
  ADD COLUMN IF NOT EXISTS provider_attempted_at TIMESTAMPTZ;

COMMENT ON COLUMN payments.processing_since IS
  'When this row entered ''processing''. Trigger-maintained — cleared when it '
  'leaves. The sweep''s clock.';
COMMENT ON COLUMN payments.pre_claim_status IS
  'The status this row held immediately before it was claimed into '
  '''processing''. Trigger-maintained, so a claimer cannot forget it and a '
  'process that dies mid-flight cannot lose it.';
COMMENT ON COLUMN payments.provider_attempted_at IS
  'Set by CODE immediately BEFORE handing the charge to the payment provider. '
  'Means "may be in flight", never "succeeded". NULL on a stuck row means '
  'nothing was ever sent, which is the only case a sweep may safely revert.';

-- ── 2. The trigger ─────────────────────────────────────────────────────────
--
-- Entering 'processing' stamps both columns. LEAVING it clears
-- processing_since (so the partial index below stays small and a collected
-- row cannot look stale) but KEEPS pre_claim_status, which is evidence about
-- what happened and costs nothing to retain.
--
-- provider_attempted_at is cleared on the way out too: it describes one
-- attempt, and a row that is claimed again later starts a fresh one. Leaving
-- a stale value would make the next strand look like it had been sent.

CREATE OR REPLACE FUNCTION track_payment_processing_claim()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'processing' AND OLD.status IS DISTINCT FROM 'processing' THEN
    NEW.processing_since := now();
    NEW.pre_claim_status := OLD.status;
    -- A new claim, so any previous attempt's marker is not about this one.
    NEW.provider_attempted_at := NULL;
  ELSIF NEW.status IS DISTINCT FROM 'processing' AND OLD.status = 'processing' THEN
    NEW.processing_since      := NULL;
    NEW.provider_attempted_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_track_payment_processing_claim ON payments;
CREATE TRIGGER trg_track_payment_processing_claim
  BEFORE UPDATE ON payments
  FOR EACH ROW
  EXECUTE FUNCTION track_payment_processing_claim();

-- A row INSERTED straight into 'processing' — instalment 1 of a new
-- schedule (claim_credit_for_plan) and every settlement row — needs the
-- stamp too, or the sweep would read NULL and treat a genuinely stuck row as
-- ineligible. pre_claim_status stays NULL there, correctly: it had none.
CREATE OR REPLACE FUNCTION stamp_payment_processing_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'processing' AND NEW.processing_since IS NULL THEN
    NEW.processing_since := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_payment_processing_insert ON payments;
CREATE TRIGGER trg_stamp_payment_processing_insert
  BEFORE INSERT ON payments
  FOR EACH ROW
  EXECUTE FUNCTION stamp_payment_processing_insert();

-- ── 3. Backfill ────────────────────────────────────────────────────────────
--
-- Any row already sitting in 'processing' when this migration runs is, by
-- definition, one of the rows the finding is about — it has been there since
-- before there was a clock. created_at is the most conservative stamp
-- available: it makes such a row look as old as it possibly is, so the sweep
-- reports it on the first run rather than waiting another N hours.
--
-- provider_attempted_at is backfilled TOO, to the same value, and that is a
-- deliberate act of pessimism: for a row that predates this migration there
-- is no provenance at all, and "we do not know whether a charge was sent"
-- must never be read as "nothing was sent". Stamping it puts every legacy row
-- in the report-only tier, where a human looks at it, rather than in the
-- auto-revert tier, where the machine would guess.
--
-- It also means the sweep needs no special case for the migration boundary:
-- the column says what it says, and the rule reads the same on day one as it
-- does a year later.

UPDATE payments
   SET processing_since      = created_at,
       provider_attempted_at = created_at
 WHERE status = 'processing'
   AND processing_since IS NULL;

-- ── 4. The sweep's index ───────────────────────────────────────────────────
--
-- Partial on the only status the sweep looks at, so it stays roughly the
-- size of the in-flight set rather than the payments table.

CREATE INDEX IF NOT EXISTS payments_processing_since_idx
  ON payments (processing_since)
  WHERE status = 'processing';

REVOKE ALL ON FUNCTION track_payment_processing_claim()  FROM PUBLIC;
REVOKE ALL ON FUNCTION stamp_payment_processing_insert() FROM PUBLIC;

COMMENT ON FUNCTION track_payment_processing_claim() IS
  'Maintains payments.processing_since / pre_claim_status across claims into '
  'and out of ''processing''. A trigger rather than four call sites, because '
  'the forgotten call site is the failure mode (audit A-13).';
