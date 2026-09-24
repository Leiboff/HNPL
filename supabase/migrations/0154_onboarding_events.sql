-- Append-only, server-authored onboarding funnel ledger.
CREATE TABLE IF NOT EXISTS onboarding_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  journey_id TEXT,
  step TEXT NOT NULL CHECK (step = ANY (ARRAY['phone','salary','identity','credit_check','completion'])),
  event_type TEXT NOT NULL CHECK (event_type = ANY (ARRAY[
    'phone_viewed','phone_submit_started','phone_saved','phone_submit_failed','otp_send_started','otp_sent','otp_send_failed','otp_verify_started','otp_verified','otp_verify_failed',
    'salary_viewed','salary_submit_started','salary_saved','salary_submit_failed','identity_viewed','identity_submit_started','identity_provider_started','identity_provider_failed','identity_approved','identity_declined',
    'credit_check_viewed','credit_check_started','credit_check_completed','credit_check_failed','onboarding_completed'
  ])),
  outcome TEXT CHECK (outcome IS NULL OR outcome = ANY (ARRAY['started','success','failure'])),
  error_code TEXT CHECK (error_code IS NULL OR error_code = ANY (ARRAY[
    'invalid_phone','network_error','sms_failed','sms_not_configured','rate_limited','wrong_code','expired','invalid_code','phone_taken',
    'invalid_salary','save_failed','invalid_identity','underage','consent_required','provider_unavailable','provider_declined','risk_refused','unknown_error'
  ])),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object' AND metadata - ARRAY['provider','source'] = '{}'::jsonb),
  dedupe_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_events_user_timeline_idx ON onboarding_events (user_id, created_at, id);
CREATE INDEX IF NOT EXISTS onboarding_events_funnel_idx ON onboarding_events (step, event_type, created_at);
ALTER TABLE onboarding_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS onboarding_events_admin_read ON onboarding_events;
CREATE POLICY onboarding_events_admin_read ON onboarding_events FOR SELECT TO authenticated USING (is_platform_admin());
REVOKE ALL ON onboarding_events FROM anon, authenticated;
GRANT SELECT ON onboarding_events TO authenticated;
GRANT SELECT, INSERT ON onboarding_events TO service_role;
COMMENT ON TABLE onboarding_events IS 'Append-only service-authored onboarding telemetry. Admin read only; abandonment is inferred from stale viewed/started events without a matching success.';
