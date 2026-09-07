-- Recover abandoned Experian attempts and retain the distinct signup policy.

ALTER TABLE bureau_enquiries
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NOT NULL
    DEFAULT (NOW() + INTERVAL '5 minutes'),
  ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signup_gate_outcome TEXT,
  ADD COLUMN IF NOT EXISTS signup_gate_reason TEXT,
  ADD COLUMN IF NOT EXISTS effective_risk_band SMALLINT,
  ADD CONSTRAINT bureau_enquiries_signup_gate_outcome_chk
    CHECK (signup_gate_outcome IS NULL OR signup_gate_outcome IN ('pass', 'refuse', 'unavailable')),
  ADD CONSTRAINT bureau_enquiries_effective_band_range
    CHECK (effective_risk_band IS NULL OR effective_risk_band BETWEEN 1 AND 5);

-- Opening is one transaction: serialize contenders for an ID, close only a
-- demonstrably expired lease, then insert the successor. The old row remains
-- intact as reconciliation evidence and is explicitly marked abandoned.
CREATE OR REPLACE FUNCTION open_bureau_enquiry_attempt(
  p_profile_id UUID,
  p_id_number_hash TEXT,
  p_version TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_id_number_hash));

  UPDATE bureau_enquiries
     SET completed_at = NOW(),
         abandoned_at = NOW(),
         outcome = 'transport_error',
         decision = 'error',
         decision_detail = 'attempt lease expired before completion'
   WHERE id_number_hash = p_id_number_hash
     AND completed_at IS NULL
     AND lease_expires_at <= NOW();

  INSERT INTO bureau_enquiries (profile_id, id_number_hash, p_version)
  VALUES (p_profile_id, p_id_number_hash, p_version)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION open_bureau_enquiry_attempt(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_bureau_enquiry_attempt(UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION open_bureau_enquiry_attempt(UUID, TEXT, TEXT) IS
  'Atomically reclaims an expired five-minute enquiry lease and opens its successor.';
