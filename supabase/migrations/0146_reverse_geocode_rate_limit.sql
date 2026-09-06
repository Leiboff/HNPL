-- ─── Shared quota for the billable reverse-geocoding route ─────────────
-- A serverless-local Map does not survive or coordinate across instances.
-- Keep this list in lockstep with RateLimitBucket in lib/security/rateLimit.ts.
--
-- ─── WHY THIS FILE IS 0146 AND NOT 0138 ────────────────────────────────
--
-- It was authored as 0137, renumbered to 0138 when it collided with
-- 0137_rls_catalog_snapshot, and collided a second time: production had
-- already recorded 0138 as `identity_signals`, applied from a branch that
-- never merged. 0139 and 0140 were taken the same way, and 0141 is applied,
-- so the first free version above the applied history is 0146.
--
-- The version is the only thing that changed. Two files at one version are
-- ambiguous to the CLI, and renumbering the already-reviewed 0142-0145 to
-- open a slot below them would have been the larger edit for no gain.
--
-- ─── AND WHY THE LIST GAINED A BUCKET IT DID NOT ADD ───────────────────
--
-- Moving to 0146 puts this file AFTER 0145, so its declaration is now the
-- one the database ends up with. `rate_limit_known_bucket` is CREATE OR
-- REPLACE and the function IS the list, so the last declaration has to
-- restate every bucket or it silently drops the ones it omits — here that
-- would have been 0145's `referral_invite`, deleting a live limit as a side
-- effect of a renumber. Restating in full is 0145's own convention, and
-- lib/security/rateLimit.buckets.test.ts pins this list against
-- RateLimitBucket precisely so the omission cannot pass review.
--
-- Note that 0134's file lists `reverse_geocode` but production's applied
-- 0134 does not: the bucket was added to that file after it had already
-- run. A fresh database gets the bucket from 0134; production gets it here.

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
    'reverse_geocode',
    -- Added by 0145, restated here because this declaration supersedes it.
    'referral_invite'
  );
$$;

REVOKE ALL ON FUNCTION rate_limit_known_bucket(TEXT) FROM PUBLIC;
