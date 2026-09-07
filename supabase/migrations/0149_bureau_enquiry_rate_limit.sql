-- ─── A shared quota for the billable bureau enquiry ────────────────────
--
-- Adds the `bureau_enquiry` bucket. Keep this list in lockstep with
-- RateLimitBucket in lib/security/rateLimit.ts —
-- lib/security/rateLimit.buckets.test.ts pins the two against each other.
--
-- ─── WHY THIS SURFACE NEEDS ITS OWN BUCKET ─────────────────────────────
--
-- The Experian enquiry now runs at the IDENTITY step, on the SA ID the
-- applicant has just typed and which NOTHING HAS YET VERIFIED. That
-- ordering is deliberate — it decides before the DHA lookup and the Didit
-- face-match session are paid for — but it changes who can be harmed by
-- abuse of the surface, and that is what this bucket is for.
--
-- The existing controls bound the CALLER: `identity_session` limits per IP
-- and per account, and evaluate_risk refuses an ID already on the platform.
-- None of them bounds enquiries against ONE PERSON'S FILE from many
-- callers. That matters here in a way it does not for any other limited
-- surface, because a bureau enquiry is recorded on the subject's credit
-- record and repeated enquiries lower their score — "High Number of Recent
-- Enquiries" is reason code 58/59 in Experian's own specification.
--
-- So the second key is the SA ID BLIND INDEX, not the account: whoever is
-- asking, one person's file may only be enquired against so often. It is
-- the same hashed value evaluate_risk is already given at this call site
-- (hashIdForLookup of the typed ID), so no new class of data enters the
-- limiter's store — and the limiter re-hashes every subject under a
-- separate key again before it reaches a log line.
--
-- The 45-day enquiry cache in lib/experian/ already suppresses a repeat
-- pull once one has SUCCEEDED. This bounds the case the cache cannot: a
-- pull that errors, and is therefore retried, against an ID the caller does
-- not own.
--
-- ─── WHY THE FUNCTION RESTATES EVERY BUCKET ────────────────────────────
--
-- `rate_limit_known_bucket` is CREATE OR REPLACE and the function IS the
-- list, so the last declaration wins and has to name every bucket or it
-- silently drops the ones it omits. 0146 is the current holder; this
-- supersedes it and restates its list in full.

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
    'reverse_geocode', 'referral_invite',
    -- Added by 0149. Keyed per IP and per SA ID blind index.
    'bureau_enquiry'
  );
$$;

REVOKE ALL ON FUNCTION rate_limit_known_bucket(TEXT) FROM PUBLIC;

COMMENT ON FUNCTION rate_limit_known_bucket(TEXT) IS
  'The declared rate-limit buckets. CREATE OR REPLACE, so the LAST migration '
  'to declare it wins and must restate the whole list. Mirrors '
  'RateLimitBucket in lib/security/rateLimit.ts; the two are pinned against '
  'each other by lib/security/rateLimit.buckets.test.ts.';
