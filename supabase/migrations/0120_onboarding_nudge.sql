-- ─── Abandoned-onboarding nudge: state, cohort, and atomic claim ────────
--
-- A patient who confirms their email and then stops is never contacted
-- again. The resume path works — log in and /onboarding forwards you to
-- the first unfinished step — but nothing brings them back to log in.
-- This migration adds what an email nudge needs and nothing else.
--
-- ─── WHY A STALENESS CHECK RATHER THAN A DELAY ──────────────────────────
--
-- The obvious rule, "email confirmed 5 minutes ago and onboarding not
-- finished", describes a large number of patients who are actively
-- progressing. The steps after email take longer than five minutes
-- between them: the phone step is an SMS round trip, and the identity
-- step redirects OFF-SITE to Didit for a liveness and document ceremony
-- that resolves asynchronously by webhook — during which the patient is
-- not on our site at all. A nudge on elapsed time alone lands in the
-- inbox of someone in the middle of finishing, which reads as broken.
--
-- So the cohort is defined by absence of PROGRESS, not passage of time,
-- and it excludes anyone with an identity session in flight.

-- ─── 1. State ───────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS onboarding_last_progress_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_nudge_count        SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS onboarding_nudge_last_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.onboarding_last_progress_at IS
  'When this patient last moved FORWARD through onboarding. Set by the '
  'auth.users email-confirmation trigger below, then touched by each step '
  'action as it saves. NULL means "never confirmed an email under this '
  'feature" — which is also what keeps the pre-existing back catalogue of '
  'abandoned signups out of the nudge cohort. See migration 0120.';

COMMENT ON COLUMN public.profiles.onboarding_nudge_count IS
  'How many abandoned-onboarding nudges have been sent. Capped at 2 by '
  'claim_onboarding_nudges. Incremented by the CLAIM, before the email is '
  'sent — losing a nudge to a failed send is much better than sending a '
  '"you did not finish" email to someone who did.';

-- The cohort query filters on these three together. Partial, because a
-- finished patient is never a candidate and there are far more of those.
CREATE INDEX IF NOT EXISTS idx_profiles_onboarding_nudge_cohort
  ON public.profiles (onboarding_last_progress_at, onboarding_nudge_count)
  WHERE onboarding_completed = FALSE;

-- ─── 2. The first progress mark: email confirmation ─────────────────────
--
-- This has to be a trigger rather than application code. The whole point
-- of the nudge is to reach a patient who confirmed their email and then
-- loaded nothing further — so anything that waits for the next page view
-- would fail to mark exactly the cohort we are trying to find.
--
-- AFTER UPDATE on auth.users, mirroring on_auth_user_created (0023).
-- Guarded on the NULL → NOT NULL transition so that later updates to the
-- row (a password change, a metadata write) do not reset the clock and
-- postpone a nudge indefinitely.

CREATE OR REPLACE FUNCTION public.mark_email_confirmed_progress()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL THEN
    UPDATE public.profiles
       SET onboarding_last_progress_at = NOW()
     WHERE id = NEW.id
       AND onboarding_completed = FALSE
       -- Only ever the FIRST confirmation. COALESCE rather than a plain
       -- IS NULL so a re-confirmation cannot rewind a later step's mark.
       AND onboarding_last_progress_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_email_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.mark_email_confirmed_progress();

COMMENT ON FUNCTION public.mark_email_confirmed_progress() IS
  'Stamps profiles.onboarding_last_progress_at at the moment an email is '
  'first confirmed, so the nudge cohort can include a patient who never '
  'loaded another page. Google patients arrive already confirmed and so '
  'are stamped by 0023''s insert path instead — see the backfill below.';

-- Google/OAuth patients are created with email_confirmed_at already set,
-- so the UPDATE trigger never fires for them. Their clock starts at
-- profile creation, which is the same moment in practice.
CREATE OR REPLACE FUNCTION public.mark_oauth_signup_progress()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email_confirmed_at IS NOT NULL THEN
    UPDATE public.profiles
       SET onboarding_last_progress_at = NOW()
     WHERE id = NEW.id
       AND onboarding_last_progress_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created_confirmed
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.mark_oauth_signup_progress();

-- ─── 2b. Every later progress mark ──────────────────────────────────────
--
-- One trigger rather than a touch in each step action, for two reasons.
--
-- First, not every step goes through application code. phone_verified_at
-- is set by the verify_phone_otp_for_user RPC and the identity columns are
-- written by the Didit webhook handler; a per-action touch would silently
-- miss both, and a patient who verified their phone would look idle.
--
-- Second, a sixth step added later would have to remember to touch the
-- column. Here it cannot forget: the trigger watches the columns the
-- onboarding state machine actually reads, so anything that moves a
-- patient forward moves the clock.

CREATE OR REPLACE FUNCTION public.touch_onboarding_progress()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- The columns lib/onboarding/state.ts computes the step list from, plus
  -- `phone` (entered one sub-stage before it is verified) and the identity
  -- session status. A row comparison rather than eight OR'd checks so that
  -- adding a column here is one edit in one place.
  IF ROW(NEW.phone, NEW.phone_verified_at, NEW.sa_id_number, NEW.salary_day,
         NEW.salary_amount, NEW.credit_check_status, NEW.liveness_verified_at,
         NEW.identity_verification_status)
     IS DISTINCT FROM
     ROW(OLD.phone, OLD.phone_verified_at, OLD.sa_id_number, OLD.salary_day,
         OLD.salary_amount, OLD.credit_check_status, OLD.liveness_verified_at,
         OLD.identity_verification_status)
  THEN
    NEW.onboarding_last_progress_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

-- BEFORE, so the assignment lands in the row being written rather than
-- costing a second UPDATE. Not SECURITY DEFINER: it only writes a column
-- on the row already being modified, so it needs no privilege the writer
-- does not already hold.
CREATE OR REPLACE TRIGGER profiles_touch_onboarding_progress
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_onboarding_progress();

COMMENT ON FUNCTION public.touch_onboarding_progress() IS
  'Moves profiles.onboarding_last_progress_at to NOW() whenever a column '
  'the onboarding state machine reads actually changes. Catches the RPC '
  'and webhook writers that never pass through application code. The nudge '
  'cohort in claim_onboarding_nudges is defined by absence of progress, so '
  'this is what makes "idle" mean idle rather than merely "signed up a '
  'while ago". See migration 0120.';

-- ─── 3. Atomic claim ────────────────────────────────────────────────────
--
-- Returns the patients due a nudge AND counts the nudge in one statement.
-- Claim-then-send, not send-then-mark: two overlapping cron invocations
-- must not both send. FOR UPDATE SKIP LOCKED is the standard queue claim.
--
-- The step the patient is stuck on is NOT computed here. lib/onboarding/
-- state.ts owns that decision, and a second copy of a five-step state
-- machine in SQL would drift from it — migration 0066 already carries one
-- partial copy and it is a maintenance liability. This returns the raw
-- flags and the TypeScript caller runs computeOnboarding().

CREATE OR REPLACE FUNCTION public.claim_onboarding_nudges(
  p_stale_minutes      INT,
  p_second_after_hours INT,
  p_limit              INT
)
RETURNS TABLE (
  id                    UUID,
  email                 TEXT,
  first_name            TEXT,
  nudge_number          SMALLINT,
  phone_verified_at     TIMESTAMPTZ,
  sa_id_number          TEXT,
  -- INTEGER, not SMALLINT: profiles.salary_day is int4, and a RETURNS
  -- TABLE column that disagrees fails at call time with "structure of
  -- query does not match function result type".
  salary_day            INTEGER,
  salary_amount         NUMERIC,
  credit_check_status   TEXT,
  liveness_verified_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT p.id
    FROM public.profiles p
    WHERE p.onboarding_completed = FALSE
      -- Patients only. A role-promoted staff account is not in this funnel.
      AND (p.role IS NULL OR p.role = 'patient')
      -- No acceptance, no account, no nudge. An account with a NULL
      -- terms_accepted_at should not be in the app at all, and chasing one
      -- would be chasing someone who never agreed to be contacted.
      AND p.terms_accepted_at IS NOT NULL
      -- Set only by the triggers above, so pre-existing abandoned signups
      -- are excluded and shipping this cannot mass-mail the back catalogue.
      AND p.onboarding_last_progress_at IS NOT NULL
      AND p.onboarding_nudge_count < 2
      -- An identity session awaiting Didit's webhook is a patient who is
      -- verifying RIGHT NOW, off-site. 'abandoned', 'expired' and
      -- 'declined' are terminal and do not protect them from a nudge.
      AND COALESCE(p.identity_verification_status, '') NOT IN ('pending', 'in_review')
      AND CASE p.onboarding_nudge_count
            -- First nudge: no forward progress for p_stale_minutes.
            WHEN 0 THEN p.onboarding_last_progress_at
                          < NOW() - (p_stale_minutes || ' minutes')::INTERVAL
            -- Second: measured from the first nudge, and still no progress
            -- since. Someone who came back, did a step and stopped again
            -- gets their clock reset by the step, not another nudge here.
            ELSE        p.onboarding_nudge_last_sent_at
                          < NOW() - (p_second_after_hours || ' hours')::INTERVAL
                        AND p.onboarding_last_progress_at
                          < p.onboarding_nudge_last_sent_at
          END
    ORDER BY p.onboarding_last_progress_at
    LIMIT p_limit
    FOR UPDATE OF p SKIP LOCKED
  )
  UPDATE public.profiles p
     SET onboarding_nudge_count        = p.onboarding_nudge_count + 1,
         onboarding_nudge_last_sent_at = NOW()
   WHERE p.id IN (SELECT due.id FROM due)
  RETURNING
    p.id,
    p.email,
    p.first_name,
    p.onboarding_nudge_count,          -- already incremented: 1 or 2
    p.phone_verified_at,
    p.sa_id_number,
    p.salary_day,
    p.salary_amount,
    p.credit_check_status,
    p.liveness_verified_at;
END;
$$;

-- Enumeration and spam surface both: this hands back email addresses and
-- causes mail to be sent. Server-side only, service_role alone.
REVOKE ALL     ON FUNCTION public.claim_onboarding_nudges(INT, INT, INT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.claim_onboarding_nudges(INT, INT, INT) FROM anon;
REVOKE ALL     ON FUNCTION public.claim_onboarding_nudges(INT, INT, INT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_onboarding_nudges(INT, INT, INT) TO   service_role;

COMMENT ON FUNCTION public.claim_onboarding_nudges(INT, INT, INT) IS
  'Claims and returns patients due an abandoned-onboarding nudge, '
  'incrementing the count in the same statement so overlapping cron runs '
  'cannot double-send. Excludes: finished patients, non-patients, accounts '
  'with no recorded T&C acceptance, patients with no progress mark (the '
  'pre-0120 back catalogue), anyone already nudged twice, and anyone with '
  'a Didit session in flight. Returns onboarding flags rather than a step '
  'name — lib/onboarding/state.ts owns that computation.';
