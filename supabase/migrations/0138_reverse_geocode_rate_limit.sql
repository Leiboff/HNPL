-- ─── Shared quota for the billable reverse-geocoding route ─────────────
-- A serverless-local Map does not survive or coordinate across instances.
-- Keep this list in lockstep with RateLimitBucket in lib/security/rateLimit.ts.

CREATE OR REPLACE FUNCTION rate_limit_known_bucket(p_bucket TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_bucket IN (
    'signup', 'resend_confirmation', 'checkout_initiate', 'identity_session',
    'till_registration', 'public_lead', 'contact_form', 'accept_plan',
    'pay_saved_card', 'self_settle', 'counter_session', 'credit_check',
    'reverse_geocode'
  );
$$;

REVOKE ALL ON FUNCTION rate_limit_known_bucket(TEXT) FROM PUBLIC;
