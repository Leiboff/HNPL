-- ─── Configurable database backstop for bill amounts (audit S-05) ─────
--
-- R30,000 is the absolute safety ceiling. An admin may lower (or restore)
-- the live product maximum from /admin/settings, but no dashboard setting
-- can widen the database beyond R30,000 without a reviewed migration.

CREATE TABLE platform_settings (
  singleton       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  max_bill_amount NUMERIC(10,2) NOT NULL DEFAULT 30000
    CHECK (max_bill_amount > 0 AND max_bill_amount <= 30000),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES profiles(id)
);

INSERT INTO platform_settings (singleton, max_bill_amount)
VALUES (TRUE, 30000);

ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_settings_admin_select ON platform_settings FOR SELECT
  USING (is_platform_admin());

-- The fixed CHECK is deliberately independent of the mutable setting. It is
-- validated against history during deployment and remains the final backstop
-- even if a future code path forgets to consult platform_settings.
ALTER TABLE plans
  ADD CONSTRAINT plans_total_amount_sane
  CHECK (total_amount > 0 AND total_amount <= 30000)
  NOT VALID;

ALTER TABLE plans VALIDATE CONSTRAINT plans_total_amount_sane;

CREATE OR REPLACE FUNCTION enforce_configured_bill_maximum()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  configured_max NUMERIC(10,2);
BEGIN
  SELECT max_bill_amount INTO configured_max
  FROM platform_settings
  WHERE singleton = TRUE;

  IF configured_max IS NULL THEN
    RAISE EXCEPTION 'bill amount policy is not configured';
  END IF;

  IF NEW.total_amount > configured_max THEN
    RAISE EXCEPTION 'plan total % exceeds configured maximum %',
      NEW.total_amount, configured_max
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'plans_total_amount_configured_max';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_configured_bill_maximum
  BEFORE INSERT OR UPDATE OF total_amount ON plans
  FOR EACH ROW EXECUTE FUNCTION enforce_configured_bill_maximum();

-- Add a first-class audit entity for platform-wide settings. The log stays
-- append-only; the service-only RPC below is the only setting writer.
ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_entity_type_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_entity_type_check
  CHECK (entity_type IN (
    'practice', 'customer', 'practice_group', 'payout', 'payout_batch',
    'payment', 'auth_factor', 'platform_setting'
  ));

CREATE OR REPLACE FUNCTION set_max_bill_amount(
  p_amount NUMERIC,
  p_actor_id UUID
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  previous_amount NUMERIC(10,2);
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 30000
     OR p_amount <> ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'max bill amount must be between 0.01 and 30000.00';
  END IF;

  SELECT max_bill_amount INTO previous_amount
  FROM platform_settings
  WHERE singleton = TRUE
  FOR UPDATE;

  UPDATE platform_settings
  SET max_bill_amount = p_amount,
      updated_at = NOW(),
      updated_by = p_actor_id
  WHERE singleton = TRUE;

  IF p_amount IS DISTINCT FROM previous_amount THEN
    INSERT INTO admin_audit_log (
      actor_id, entity_type, entity_id, action, payload
    ) VALUES (
      p_actor_id,
      'platform_setting',
      '00000000-0000-0000-0000-000000000001'::UUID,
      'max_bill_amount_changed',
      jsonb_build_object('from', previous_amount, 'to', p_amount)
    );
  END IF;

  RETURN p_amount;
END;
$$;

REVOKE ALL ON FUNCTION enforce_configured_bill_maximum() FROM PUBLIC;
REVOKE ALL ON FUNCTION set_max_bill_amount(NUMERIC, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_max_bill_amount(NUMERIC, UUID) TO service_role;

COMMENT ON TABLE platform_settings IS
  'Singleton platform-wide controls editable by a fresh-AAL2 administrator.';
COMMENT ON COLUMN platform_settings.max_bill_amount IS
  'Live product maximum in rands; cannot exceed the R30,000 database ceiling.';
COMMENT ON CONSTRAINT plans_total_amount_sane ON plans IS
  'Absolute invariant: plan totals are positive and at most R30,000 (S-05).';
