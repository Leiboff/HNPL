-- ─── Referrals: the infrastructure, deliberately without the programme ────
--
-- A patient can refer two different things, and they are not the same object:
--
--   a FRIEND    → who becomes a patient. Attribution happens at signup, and
--                 the referral converts when their first plan goes active.
--   a PRACTICE  → which becomes a merchant. Attribution happens in the CRM,
--                 because a practice is not a self-serve signup — a rep works
--                 it through the pipeline that already exists (crm_leads,
--                 0069) and it converts when the practice is approved.
--
-- Both are one row in `referrals`, differing by `kind`, because the questions
-- an operator asks are the same for both — who referred, did it land, did it
-- convert — and two tables would mean two answers to each of them.
--
-- ═══════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION IS NOT
-- ═══════════════════════════════════════════════════════════════════════
--
-- There is no incentive here. No reward amount, no credit issuance, no
-- payout, no "R100 when your friend's first payment clears". That was the
-- explicit scope: build the plumbing, decide the offer later.
--
-- That is a real constraint on this file rather than an omission, because the
-- tempting thing to do is guess. A `reward_cents` column with nothing writing
-- it, a `reward_status` enum whose states were invented before the policy
-- existed — both would be read by the next person as a decision somebody
-- made, and the incentive programme would then be designed around a schema
-- rather than the other way round.
--
-- So there is exactly ONE seam, and it is a timestamp:
--
--     referrals.qualified_at
--
-- Nothing in this repository sets it. It is the column a future programme
-- stamps when a referral meets whatever bar that programme defines, and it
-- exists NOW so that the bar can be applied retrospectively to referrals
-- made before the programme launched — which is the one thing that cannot be
-- fixed later, because the referrals themselves would not have been recorded.
--
-- docs/REFERRALS.md is the companion: what exists, what is missing, and the
-- five decisions the incentive programme has to make.
--
-- ═══════════════════════════════════════════════════════════════════════
-- WRITES: SERVICE ROLE ONLY, AND WHY THERE ARE NO INSERT POLICIES
-- ═══════════════════════════════════════════════════════════════════════
--
-- Every table here has SELECT policies and nothing else. A patient cannot
-- INSERT a referral, cannot UPDATE one, and cannot mint themselves a code.
--
-- This is the lesson of R3-01 and R3-02 applied before the fact rather than
-- after it (see lib/security/schemaInvariants.ts, which exists because two
-- audits found the same shape twice). A user-reachable INSERT on a table
-- whose columns decide who gets credited is exactly the payouts hole again:
-- the policy constrains WHICH ROW you may write, never WHAT IS IN IT, so a
-- patient could have inserted a row naming themselves as the referrer of an
-- account they do not own, with a status of 'converted', and been correct
-- about none of it.
--
-- All writes therefore go through Server Actions on the service-role client
-- (app/patient/refer/actions.ts), which re-verify the caller's role and build
-- the row themselves. That is the architecture this repo already states for
-- every write that matters, and it means this table needs no BEFORE INSERT
-- guard trigger, because there is no user INSERT to guard.
--
-- ═══════════════════════════════════════════════════════════════════════
-- PERSONAL INFORMATION, AND THE PERSON WHO NEVER AGREED TO ANYTHING
-- ═══════════════════════════════════════════════════════════════════════
--
-- An invitation holds a name and an email address for somebody who is not a
-- customer, never signed up, and has no relationship with this platform. That
-- is lawful as a referral (POPIA §11(1)(f) — the legitimate interest of
-- passing on an invitation somebody asked us to pass on) and it stops being
-- lawful the moment we keep it after the invitation is dead.
--
-- So: `expires_at` on every invitation, and `prune_referral_invites()` at the
-- foot of this file, which SCRUBS the contact details out of dead invitations
-- while keeping the referral row itself. The row is the record that a
-- referral was made; the email address is the part with a person attached.
-- app/api/cron/referral-maintenance runs it daily.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. referral_codes — the shareable identity of a referrer
-- ══════════════════════════════════════════════════════════════════════════
--
-- A separate table rather than a column on `profiles`, for three reasons:
--
--   • a code can be REVOKED and replaced (a customer shares theirs into a
--     public forum and wants a new one) without losing the referrals the old
--     one already produced — `referrals.code_id` keeps pointing at the code
--     that actually did the work;
--   • uniqueness is enforced by an index over a small table, not by a
--     constraint on the widest table in the schema;
--   • profiles is the table two audits found columns wrongly writable on
--     (F-01/F-05 → 0121/0122), and it now has a write allow-list. Adding a
--     customer-visible column to it means revisiting that allow-list, for no
--     benefit over a table of its own.
--
-- The code's SHAPE is checked here and generated in lib/referrals/code.ts.
-- Two definitions is a drift risk, accepted for the reason 0134 gives about
-- rate-limit buckets: the database cannot check a code against the
-- application by reading it. lib/referrals/code.test.ts pins them together.

CREATE TABLE IF NOT EXISTS referral_codes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Upper case, Crockford's base-32 (no I, L, O, U, 0 or 1), eight long.
  code        TEXT        NOT NULL CHECK (code ~ '^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{8}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

-- Global uniqueness across live AND revoked codes. A revoked code must never
-- be re-issued to somebody else: links live in message histories forever, and
-- a recycled code would attribute an old link's clicks to a new owner.
CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_code_key
  ON referral_codes (code);

-- One LIVE code per person. Revoked ones accumulate, deliberately.
CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_owner_live_key
  ON referral_codes (owner_id)
  WHERE revoked_at IS NULL;

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS referral_codes_owner_select ON referral_codes;
CREATE POLICY referral_codes_owner_select
  ON referral_codes FOR SELECT
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS referral_codes_admin_select ON referral_codes;
CREATE POLICY referral_codes_admin_select
  ON referral_codes FOR SELECT
  USING (is_platform_admin());

COMMENT ON TABLE referral_codes IS
  'One live shareable code per referrer (0145). Minted by '
  'lib/referrals/code.ts on the service-role path; readable by its owner and '
  'by a platform admin. No INSERT/UPDATE/DELETE policy exists — see the '
  'header of migration 0145.';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. referrals — one row per referral, of either kind
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS referrals (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who gets the credit. ON DELETE CASCADE: if the referrer's account is
  -- erased (POPIA §24), the referrals they made go with it. The referred
  -- customer's own account is untouched — see referred_profile_id below.
  referrer_id           UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Which code produced it. SET NULL rather than CASCADE: a revoked and
  -- deleted code must not take the referral history with it.
  code_id               UUID        REFERENCES referral_codes(id) ON DELETE SET NULL,

  kind                  TEXT        NOT NULL
    CHECK (kind IN ('patient', 'practice')),
  channel               TEXT        NOT NULL DEFAULT 'link'
    CHECK (channel IN ('link', 'invite')),
  status                TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'signed_up', 'converted', 'expired', 'void')),

  -- ── The invitee, before they are anybody in our system ────────────────
  -- Scrubbed by prune_referral_invites() once the invitation is dead. Every
  -- one of these is nullable because a link-channel referral has none of
  -- them: nobody was invited, somebody simply arrived carrying a code.
  invitee_name          TEXT,
  invitee_email         TEXT,
  invitee_phone         TEXT,
  practice_name         TEXT,
  note                  TEXT,

  -- ── What it became ────────────────────────────────────────────────────
  -- ON DELETE SET NULL throughout: deleting the referred party's account must
  -- not delete the referrer's record that a referral happened, and the row
  -- with its contact columns scrubbed carries no personal information about
  -- them.
  referred_profile_id   UUID        REFERENCES profiles(id)  ON DELETE SET NULL,
  crm_lead_id           UUID        REFERENCES crm_leads(id) ON DELETE SET NULL,
  converted_practice_id UUID        REFERENCES practices(id) ON DELETE SET NULL,
  converted_plan_id     UUID        REFERENCES plans(id)     ON DELETE SET NULL,

  -- ── The seam for an incentive programme that does not exist yet ───────
  -- NOTHING in this repository writes this column. See the header.
  qualified_at          TIMESTAMPTZ,

  signed_up_at          TIMESTAMPTZ,
  converted_at          TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ── Shape constraints ─────────────────────────────────────────────────

  -- Nobody refers themselves. Cheap, obvious, and the first thing anybody
  -- tries — enforced in the database as well as in claimReferral because the
  -- application check protects the link path and this protects every path.
  CONSTRAINT referrals_not_self
    CHECK (referred_profile_id IS NULL OR referred_profile_id <> referrer_id),

  -- A practice referral without a practice name is not a referral, it is a
  -- blank row: the name is the only thing a rep can act on.
  CONSTRAINT referrals_practice_named
    CHECK (kind <> 'practice' OR practice_name IS NOT NULL),

  -- The two kinds convert into different objects, and crossing them would
  -- make every count wrong in a way no query would reveal.
  CONSTRAINT referrals_patient_has_no_lead
    CHECK (kind <> 'patient' OR (crm_lead_id IS NULL AND converted_practice_id IS NULL)),
  CONSTRAINT referrals_practice_has_no_plan
    CHECK (kind <> 'practice' OR (converted_plan_id IS NULL AND referred_profile_id IS NULL)),

  -- A link referral has no invitee to hold: nobody was invited, somebody
  -- arrived carrying a code. Stated as an implication on the LINK side rather
  -- than as a NOT NULL on the invite side, so an invitation's contact columns
  -- can be SCRUBBED later without dropping the constraint — a dead invitation
  -- keeps channel='invite' and loses its address, which is the whole point of
  -- prune_referral_invites().
  CONSTRAINT referrals_link_has_no_invitee
    CHECK (channel <> 'link' OR (
      invitee_email IS NULL AND invitee_phone IS NULL AND invitee_name IS NULL
    )),

  -- A practice is never referred by a link: there is no practice signup a
  -- code could be carried into. Nominating one is always an explicit act in
  -- the app, which is what channel='invite' means.
  CONSTRAINT referrals_link_is_patient_only
    CHECK (channel <> 'link' OR kind = 'patient'),

  -- Normalised on the way in, and refused here if it was not. The open-invite
  -- index below and findPendingInviteFor both match on the stored value, so a
  -- single mixed-case address would quietly defeat both.
  CONSTRAINT referrals_invitee_email_normalised
    CHECK (invitee_email IS NULL OR invitee_email = lower(invitee_email))
);

-- ── Attribution is WRITE-ONCE ─────────────────────────────────────────────
--
-- The load-bearing index in this file. An account is referred by at most one
-- person, ever, and the FIRST code it arrives with is the one that counts.
--
-- Without this, the race is not theoretical: proxy.ts claims on EVERY
-- authenticated request, and a page that fires three parallel requests with
-- the cookie still set would run three claims concurrently. Each would read
-- "no attribution yet" and each would insert. A unique index is the only
-- thing that makes the second and third of those fail, which is why
-- createLinkReferral treats 23505 as "somebody else won" rather than as an
-- error.
CREATE UNIQUE INDEX IF NOT EXISTS referrals_referred_profile_key
  ON referrals (referred_profile_id)
  WHERE referred_profile_id IS NOT NULL;

-- One open invitation per (referrer, address). A patient who taps "invite"
-- twice on the same friend has not made two referrals, and two pending rows
-- would make findPendingInviteFor ambiguous — .maybeSingle() would fail
-- rather than match. Scoped to pending so a fresh invitation is possible once
-- the first has expired or been taken up.
CREATE UNIQUE INDEX IF NOT EXISTS referrals_open_invite_key
  ON referrals (referrer_id, lower(invitee_email))
  WHERE invitee_email IS NOT NULL AND status = 'pending';

CREATE INDEX IF NOT EXISTS referrals_referrer_idx
  ON referrals (referrer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS referrals_status_idx
  ON referrals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS referrals_lead_idx
  ON referrals (crm_lead_id)
  WHERE crm_lead_id IS NOT NULL;
-- The retention sweep's query shape.
CREATE INDEX IF NOT EXISTS referrals_expiry_idx
  ON referrals (expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- The referrer sees their own referrals. They see the invitee's address
-- because they typed it; they do NOT see anything about what the referred
-- account subsequently did beyond the status word, because nothing else about
-- another person's account belongs on a referrer's screen.
DROP POLICY IF EXISTS referrals_referrer_select ON referrals;
CREATE POLICY referrals_referrer_select
  ON referrals FOR SELECT
  USING (referrer_id = auth.uid());

DROP POLICY IF EXISTS referrals_admin_select ON referrals;
CREATE POLICY referrals_admin_select
  ON referrals FOR SELECT
  USING (is_platform_admin());

-- Deliberately absent: a policy letting the REFERRED person see the row.
-- "Who referred you" is the referrer's record, not the referred party's, and
-- a policy joining on referred_profile_id would hand every new customer the
-- email address a friend typed for them.

COMMENT ON TABLE referrals IS
  'One row per referral of a friend (kind=patient) or a practice '
  '(kind=practice), 0145. Readable by the referrer and by a platform admin; '
  'writable only by service_role through app/patient/refer/actions.ts. '
  'qualified_at is the unused seam for a future incentive programme — see '
  'docs/REFERRALS.md.';
COMMENT ON COLUMN referrals.qualified_at IS
  'NOTHING WRITES THIS YET. Reserved for the incentive programme: the moment '
  'a referral met that programme''s bar. Present now so the bar can be '
  'applied to referrals made before it launched.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. The status guard
-- ══════════════════════════════════════════════════════════════════════════
--
-- Writes are service-role only, so this trigger is not defending against a
-- customer — it is defending against US. A referral's status is the input to
-- a payment somebody will eventually make, and the two ways that goes wrong
-- are a row that walks backwards (converted → pending, so it converts twice)
-- and a timestamp that disagrees with the status it is supposed to record.
--
-- Both are one careless `.update({ status })` away in a Server Action, and
-- neither is visible in review. Stamping the timestamps here rather than at
-- the call site means they cannot be forgotten, and refusing a move out of a
-- terminal state means a double-conversion is an error rather than a payment.

CREATE OR REPLACE FUNCTION referrals_guard_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Terminal means terminal. 'void' is the deliberate exception in ONE
    -- direction: an operator must always be able to close a referral,
    -- including one that has already converted, because the reason to void a
    -- converted referral is usually that it was fraudulent.
    IF OLD.status IN ('converted', 'expired', 'void') AND NEW.status <> 'void' THEN
      RAISE EXCEPTION
        'referral % is already %; it cannot become %',
        OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status = 'signed_up' AND NEW.signed_up_at IS NULL THEN
      NEW.signed_up_at := now();
    END IF;
    IF NEW.status = 'converted' THEN
      IF NEW.signed_up_at IS NULL THEN NEW.signed_up_at := now(); END IF;
      IF NEW.converted_at IS NULL THEN NEW.converted_at := now(); END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS referrals_guard_status_trg ON referrals;
CREATE TRIGGER referrals_guard_status_trg
  BEFORE UPDATE ON referrals
  FOR EACH ROW EXECUTE FUNCTION referrals_guard_status();

COMMENT ON FUNCTION referrals_guard_status() IS
  'Touches updated_at, stamps the lifecycle timestamps, and refuses a move '
  'out of a terminal status other than to void (0145).';

-- ══════════════════════════════════════════════════════════════════════════
-- 4. Retention — the invitee who never became a customer
-- ══════════════════════════════════════════════════════════════════════════
--
-- Two jobs in one function, because they are the same sweep over the same
-- index and splitting them would mean two scans and two chances to schedule
-- only one of them:
--
--   (a) EXPIRE  a pending invitation past its window. The row stops being
--       an invitation. lib/referrals/vocabulary.ts derives this for display
--       so the screen is right before the sweep runs — the sweep makes it
--       true in the database, which is what queries and any future incentive
--       calculation read.
--
--   (b) SCRUB   the invitee's name, address and phone off invitations that
--       are dead and past the retention window. NOT a delete: the referral
--       row is the referrer's record that they made a referral, and it
--       stays. What goes is the personal information about somebody who is
--       not a customer, was never asked, and has now been sitting in our
--       database for months.
--
-- Retention is measured from the END of the invitation, not from its
-- creation, so an invitation taken up on day 29 is not scrubbed on day 30.
--
-- Returns the two counts so the cron route can log something an operator can
-- read: a scrub that suddenly does nothing is how you find out the sweep
-- stopped running.

CREATE OR REPLACE FUNCTION prune_referral_invites(
  p_scrub_after_days INT DEFAULT 90
)
RETURNS TABLE (expired_count INT, scrubbed_count INT)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired  INT;
  v_scrubbed INT;
  v_days     INT;
BEGIN
  -- Clamped rather than validated, the same posture consume_rate_limit takes
  -- (0134): a housekeeping job that THROWS on an odd argument is a job that
  -- silently stops running. The floor of 30 is the invitation window itself —
  -- scrubbing sooner would erase live invitations.
  v_days := LEAST(GREATEST(COALESCE(p_scrub_after_days, 90), 30), 3650);

  UPDATE referrals
     SET status = 'expired'
   WHERE status = 'pending'
     AND expires_at IS NOT NULL
     AND expires_at <= now();
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  UPDATE referrals
     SET invitee_name  = NULL,
         invitee_email = NULL,
         invitee_phone = NULL,
         note          = NULL
   WHERE status IN ('expired', 'void')
     AND (invitee_name IS NOT NULL OR invitee_email IS NOT NULL
          OR invitee_phone IS NOT NULL OR note IS NOT NULL)
     AND updated_at <= now() - make_interval(days => v_days);
  GET DIAGNOSTICS v_scrubbed = ROW_COUNT;

  RETURN QUERY SELECT v_expired, v_scrubbed;
END;
$$;

-- 0125 made function EXECUTE default-deny, so this is private on creation.
-- The grant is written out rather than assumed, and it goes to service_role
-- ONLY: this function rewrites rows in bulk and has no business being
-- reachable from a browser session.
REVOKE ALL ON FUNCTION prune_referral_invites(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_referral_invites(INT) TO service_role;

COMMENT ON FUNCTION prune_referral_invites(INT) IS
  'Daily referral housekeeping (0145): expires lapsed invitations and scrubs '
  'the invitee contact details off dead ones, keeping the referral row. '
  'service_role only; called by app/api/cron/referral-maintenance.';

-- ══════════════════════════════════════════════════════════════════════════
-- 5. The rate-limit bucket for sending an invitation
-- ══════════════════════════════════════════════════════════════════════════
--
-- Sending a referral invitation puts an email into a stranger's inbox from
-- our verified domain, at the request of a customer. That is a mail-bombing
-- primitive and a deliverability risk, so it gets a bucket like every other
-- surface that sends mail.
--
-- CREATE OR REPLACE of 0134's function, restating its list verbatim plus the
-- new name. The list has to be restated in full because the function IS the
-- list; lib/security/rateLimit.buckets.test.ts reads whichever migration
-- declares it LAST and pins that against RateLimitBucket in TypeScript.

CREATE OR REPLACE FUNCTION rate_limit_known_bucket(p_bucket TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_bucket IN (
    'signup',
    'resend_confirmation',
    'checkout_initiate',
    'identity_session',
    'till_registration',
    'public_lead',
    'contact_form',
    'accept_plan',
    'pay_saved_card',
    'self_settle',
    'counter_session',
    'credit_check',
    'reverse_geocode',
    -- Added by 0145: a patient inviting a friend or nominating a practice.
    'referral_invite'
  );
$$;

REVOKE ALL ON FUNCTION rate_limit_known_bucket(TEXT) FROM PUBLIC;
