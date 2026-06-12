-- Tracks card-registration refund lifecycle end-to-end.
-- One row per Paystack transaction refunded; kept in sync by the webhook.
-- The webhook uses the service-role client (bypasses RLS).
-- Platform admins can view and manage rows; patients have no access.

CREATE TABLE IF NOT EXISTS refunds (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_reference TEXT        NOT NULL,
  patient_id            UUID        REFERENCES profiles(id),
  amount_cents          INTEGER     NOT NULL,
  reason                TEXT,
  status                TEXT        NOT NULL DEFAULT 'initiated'
                          CHECK (status IN ('initiated', 'pending', 'processed', 'failed', 'manual_review')),
  paystack_refund_id    TEXT,
  initiated_at          TIMESTAMPTZ DEFAULT now(),
  processed_at          TIMESTAMPTZ,
  last_event_at         TIMESTAMPTZ,
  failure_reason        TEXT,
  raw_event             JSONB,
  UNIQUE (transaction_reference)
);

CREATE INDEX IF NOT EXISTS refunds_patient_id_idx ON refunds (patient_id);
CREATE INDEX IF NOT EXISTS refunds_status_idx     ON refunds (status);

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;

-- Platform admins can read and manage all refunds.
-- Service role bypasses RLS and is used by the webhook handler.
-- Patients have no matching policy and therefore no access.
CREATE POLICY "admins_all_refunds" ON refunds
  FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
