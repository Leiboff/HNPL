-- ─── Aggregate fraud and automated-abuse controls ──────────────────────────
--
-- THE DEFECT (audit 2026-09-03, S-07; carried from 2026-09-02 §17 and R3 §12)
--
-- Every limit this system has is OPERATION-LOCAL. `consume_rate_limit`
-- (0124/0134) is keyed on one subject at a time — an IP, an account, a token
-- — and each of those is one rotation away from a fresh budget. A ring that
-- rotates accounts, phone numbers, IPs, identities, cards and devices stays
-- under every bucket simultaneously while the aggregate cost and the
-- aggregate credit issuance grow without bound.
--
-- The loss chain the audit describes is made entirely of individually valid
-- requests:
--
--     automated signup → OTP → KYC across many identities → the
--     unconditional stub limit → a colluding or compromised practice →
--     first payment → merchant payout → default on the rest
--
-- Nothing in endpoint authorization, webhook signatures or the atomic credit
-- claim (0130) is wrong, and none of them see this. What is missing is a
-- single place where the DIMENSIONS ARE JOINED: the same device across nine
-- accounts, the same card fingerprint across four identities, one practice
-- receiving every new customer on the platform this week.
--
-- ─── WHAT THIS MIGRATION IS, AND WHAT IT IS NOT ───────────────────────────
--
-- It is the mechanism: a correlation store, a decision function that reads it
-- under lock, daily third-party and credit-issuance budgets, manual-review
-- state, per-practice circuit breakers, platform kill switches, and retention
-- rules for all of it.
--
-- It is NOT a fraud policy. The thresholds live in lib/risk/policy.ts and are
-- passed in per call, for the same reason lib/finance.ts owns the money
-- arithmetic: one definition, reviewable as a set, tested against known
-- answers. This function VALIDATES and APPLIES what it is given — it clamps
-- the bounds and refuses an event name nobody declared, exactly as
-- consume_rate_limit does, so a caller cannot widen a rule by asking nicely.
--
-- Nor is it monitoring. It writes the evidence (risk_events, risk_reviews)
-- that an alerting pipeline and a human queue consume; standing those up is
-- operational work outside this repository. docs/FRAUD-RISK-OPERATIONS.md
-- says what has to exist on the other side.
--
-- ─── NO RAW CORRELATION DATA, EVER ────────────────────────────────────────
--
-- Every value in `token` is a keyed HMAC computed in the application
-- (lib/risk/tokens.ts), never the phone number, the email, the IP, the SA ID
-- or the PAN. The store is therefore a set of opaque equality keys: it can
-- answer "are these two accounts the same device" and cannot answer "what
-- device is this". That is the whole privacy posture, and it is what makes a
-- 90-day retention on a correlation graph defensible under POPIA — see the
-- retention section at the foot of this file.
--
-- The one deliberate exception is practice_id, which is an internal UUID
-- already present on plans, payouts and bills. Tokenising it would buy no
-- privacy and would make the merchant-side queries unjoinable.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. THE DECLARED VOCABULARY
-- ══════════════════════════════════════════════════════════════════════════
--
-- Two lists the database owns, mirrored in lib/risk/policy.ts. Drift between
-- them is a real risk and it is accepted for the reason 0134 states about
-- buckets: the point is that the database refuses an event or a dimension the
-- application did not declare, which it cannot do by reading the application.
-- lib/risk/policy.vocabulary.test.ts pins the two against each other.

CREATE OR REPLACE FUNCTION risk_known_event(p_event TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_event IN (
    'signup',            -- account creation
    'checkout_initiate', -- anonymous bill-token entry; creates an auth user
    'phone_otp',         -- an SMS unit at a vendor
    'kyc_session',       -- a PAID KYC unit at Didit
    'credit_check',      -- a PAID bureau call
    'plan_acceptance',   -- credit is committed here
    'card_payment',      -- a real charge at Peach
    'payout_release',    -- money leaves the platform
    'counter_session'    -- a practice raising a bill
  );
$$;

CREATE OR REPLACE FUNCTION risk_known_dimension(p_dimension TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_dimension IN (
    'account',           -- profiles.id
    'identity',          -- the SA ID blind index (0096) — duplicate identity
    'phone',             -- normalised E.164, tokenised
    'email',             -- normalised address, tokenised
    'email_domain',      -- the domain alone: disposable-mailbox clustering
    'ip',
    'subnet',            -- /24 (v4) or /48 (v6): the cheap-rotation unit
    'asn',               -- the autonomous system: the expensive-rotation unit
    'network_class',     -- 'hosting' | 'proxy' | 'residential' | 'unknown'
    'device',            -- the first-party device cookie, tokenised
    'kyc_session',       -- the verification session / portrait signal
    'card',              -- the payment-instrument fingerprint
    'bank_account',      -- a payout destination
    'practice',
    'practice_group',
    'provider',
    'customer_merchant'  -- the customer↔merchant edge itself
  );
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. THE CORRELATION STORE
-- ══════════════════════════════════════════════════════════════════════════
--
-- One row per (event, dimension, token) observation. The velocity graph is
-- not a separate structure — it is two aggregates over this table:
--
--   count(*)                    how fast is this token moving
--   count(DISTINCT account_id)  how many accounts share it
--
-- The second is the one that matters here. A device seen 40 times by one
-- account is a person with a flaky connection; a device seen 9 times by 9
-- accounts is a ring, and no per-operation limit can tell those apart.

CREATE TABLE IF NOT EXISTS risk_observations (
  id           BIGSERIAL   PRIMARY KEY,
  event        TEXT        NOT NULL,
  dimension    TEXT        NOT NULL,
  -- A keyed HMAC from lib/risk/tokens.ts. Never a raw identifier. The one
  -- exception is 'practice'/'practice_group'/'provider', which carry the
  -- internal UUID as text — see the header.
  token        TEXT        NOT NULL,
  account_id   UUID,       -- NULL on genuinely anonymous surfaces
  practice_id  UUID,
  -- Rands, as the smallest unit, so exposure sums stay exact. Zero on the
  -- events that move no money.
  amount_cents BIGINT      NOT NULL DEFAULT 0,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only two query shapes: velocity for one (dimension, token) since a
-- cutoff, and the retention sweep.
CREATE INDEX IF NOT EXISTS risk_observations_velocity_idx
  ON risk_observations (dimension, token, occurred_at DESC);
CREATE INDEX IF NOT EXISTS risk_observations_occurred_idx
  ON risk_observations (occurred_at);
-- "Everything we have ever seen about this account", for a reviewer.
CREATE INDEX IF NOT EXISTS risk_observations_account_idx
  ON risk_observations (account_id, occurred_at DESC)
  WHERE account_id IS NOT NULL;
-- Per-practice velocity and the merchant side of the customer↔merchant edge.
CREATE INDEX IF NOT EXISTS risk_observations_practice_idx
  ON risk_observations (practice_id, occurred_at DESC)
  WHERE practice_id IS NOT NULL;

ALTER TABLE risk_observations ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately. Reached only through the SECURITY DEFINER
-- functions below and by the service-role client. Same lockdown as
-- phone_verifications and rate_limit_hits: a correlation graph readable by
-- the account it describes is a map of how to evade it.

COMMENT ON TABLE risk_observations IS
  'The aggregate fraud correlation store (0142). One row per observed '
  '(event, dimension, token). Tokens are keyed HMACs from lib/risk/tokens.ts '
  '— never raw identifiers. Written only by evaluate_risk; pruned by '
  'prune_risk_data. See docs/FRAUD-RISK-OPERATIONS.md for retention.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. THE DECISION LOG
-- ══════════════════════════════════════════════════════════════════════════
--
-- Every non-allow decision, with the reasons that produced it. This is the
-- evidence an alert cites and a reviewer reads; it is also the only way to
-- tell "the controls did nothing" from "the controls saw nothing".

CREATE TABLE IF NOT EXISTS risk_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event       TEXT        NOT NULL,
  decision    TEXT        NOT NULL CHECK (decision IN ('allow', 'friction', 'review', 'deny')),
  score       INT         NOT NULL DEFAULT 0,
  -- [{"rule":"device","metric":"accounts","observed":9,"threshold":3,
  --   "window_secs":86400,"action":"review"}, …]
  reasons     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  account_id  UUID,
  practice_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS risk_events_recent_idx
  ON risk_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS risk_events_account_idx
  ON risk_events (account_id, occurred_at DESC)
  WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS risk_events_practice_idx
  ON risk_events (practice_id, occurred_at DESC)
  WHERE practice_id IS NOT NULL;

ALTER TABLE risk_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admins_select_risk_events ON risk_events;
CREATE POLICY admins_select_risk_events ON risk_events
  FOR SELECT USING (is_platform_admin());

COMMENT ON TABLE risk_events IS
  'Risk decisions and the reasons behind them (0142). Allow decisions are '
  'not recorded — normal traffic is the overwhelming majority and its '
  'durable record is risk_observations. Admin-readable so the review queue '
  'can show why a subject was held.';

-- ══════════════════════════════════════════════════════════════════════════
-- 4. MANUAL REVIEW
-- ══════════════════════════════════════════════════════════════════════════
--
-- A 'review' decision is not a refusal and not an approval. It parks the
-- subject and creates work. Without this state the only options are "let the
-- ring through" and "lock out the household on a shared 4G NAT", and a credit
-- product cannot ship with only those two.

CREATE TABLE IF NOT EXISTS risk_reviews (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event        TEXT        NOT NULL,
  state        TEXT        NOT NULL DEFAULT 'open'
                 CHECK (state IN ('open', 'in_review', 'cleared', 'rejected')),
  account_id   UUID,
  practice_id  UUID,
  reasons      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  score        INT         NOT NULL DEFAULT 0,
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_hit_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count    INT         NOT NULL DEFAULT 1,
  decided_at   TIMESTAMPTZ,
  decided_by   UUID,
  notes        TEXT
);

-- One OPEN review per (account, event) — a ring hitting the same wall two
-- hundred times must not manufacture two hundred queue items. Repeat hits
-- bump last_hit_at and hit_count instead. Partial unique indexes ignore
-- NULLs, so the practice-only form gets its own.
CREATE UNIQUE INDEX IF NOT EXISTS risk_reviews_open_account_uniq
  ON risk_reviews (account_id, event)
  WHERE state IN ('open', 'in_review') AND account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS risk_reviews_open_practice_uniq
  ON risk_reviews (practice_id, event)
  WHERE state IN ('open', 'in_review') AND account_id IS NULL AND practice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS risk_reviews_queue_idx
  ON risk_reviews (state, last_hit_at DESC);

ALTER TABLE risk_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admins_select_risk_reviews ON risk_reviews;
CREATE POLICY admins_select_risk_reviews ON risk_reviews
  FOR SELECT USING (is_platform_admin());
-- No INSERT/UPDATE policy for anyone. Reviews are opened by evaluate_risk and
-- decided through decide_risk_review, which stamps the actor and writes the
-- admin audit trail. A reviewer clearing a row with a direct UPDATE would
-- leave no record of who cleared it.

COMMENT ON TABLE risk_reviews IS
  'The manual-review queue (0142). Opened by evaluate_risk on a review '
  'decision, deduplicated to one open row per (account, event). Decided only '
  'through decide_risk_review so every clearance is attributable.';

-- ══════════════════════════════════════════════════════════════════════════
-- 5. DAILY BUDGETS
-- ══════════════════════════════════════════════════════════════════════════
--
-- The dimension no per-subject rule can cover. A ring that rotates every
-- identifier perfectly still spends OUR money at OUR vendors, one KYC unit
-- and one bureau call and one approved rand at a time. These are the ceilings
-- on the aggregate, and they are the last line that holds when the
-- correlation rules are evaded rather than tripped.
--
-- Deliberately coarse: a day, a name, a running total. A budget that needs a
-- sliding window to be understood is a budget nobody will set correctly.

CREATE TABLE IF NOT EXISTS risk_budget_usage (
  budget    TEXT        NOT NULL,
  usage_day DATE        NOT NULL,
  consumed  NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (budget, usage_day)
);

ALTER TABLE risk_budget_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admins_select_risk_budget_usage ON risk_budget_usage;
CREATE POLICY admins_select_risk_budget_usage ON risk_budget_usage
  FOR SELECT USING (is_platform_admin());

CREATE OR REPLACE FUNCTION risk_known_budget(p_budget TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_budget IN (
    'kyc',             -- Didit sessions
    'sms',             -- SMSPortal units
    'bureau',          -- credit bureau lookups
    'payment',         -- outbound card charges
    'payout',          -- rands released to practices
    'approved_credit'  -- rands of new credit committed
  );
$$;

COMMENT ON TABLE risk_budget_usage IS
  'Daily platform-wide spend against the named risk budgets (0142). Written '
  'only by consume_risk_budget, which is atomic: the guard and the increment '
  'are one statement, so concurrent callers cannot both spend the last unit.';

-- ── consume_risk_budget ───────────────────────────────────────────────────
--
-- Count-then-write in ONE statement, on exactly the pattern 0124's
-- consume_rate_limit established and for exactly the same reason: an
-- INSERT … ON CONFLICT DO UPDATE whose WHERE clause re-reads the committed
-- total under the row lock the conflict takes. Two callers racing for the
-- last unit serialise on that lock and the loser's WHERE fails.
--
-- Returns the outcome and the numbers, so a caller that is refused can log
-- what it was refused against without a second read.

CREATE OR REPLACE FUNCTION consume_risk_budget(
  p_budget TEXT,
  p_units  NUMERIC,
  p_limit  NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_units  NUMERIC;
  v_limit  NUMERIC;
  v_after  NUMERIC;
  v_today  DATE := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF NOT risk_known_budget(p_budget) THEN
    -- A typo at a call site. Permit and warn, as 0134 does for an unknown
    -- bucket: refusing would turn a misspelled budget name into an outage,
    -- and writing the row would create a budget nothing reviews.
    RAISE WARNING 'consume_risk_budget: unknown budget %, not limiting', p_budget;
    RETURN jsonb_build_object('ok', true, 'budget', p_budget, 'skipped', true);
  END IF;

  -- Clamped, not validated — same argument as 0134. A limiter that throws is
  -- worse than a limiter with an odd bound.
  v_units := GREATEST(COALESCE(p_units, 0), 0);
  v_limit := GREATEST(COALESCE(p_limit, 0), 0);

  IF v_units = 0 THEN
    RETURN jsonb_build_object('ok', true, 'budget', p_budget, 'units', 0);
  END IF;

  INSERT INTO risk_budget_usage (budget, usage_day, consumed, updated_at)
  VALUES (p_budget, v_today, v_units, now())
  ON CONFLICT (budget, usage_day) DO UPDATE
     SET consumed   = risk_budget_usage.consumed + v_units,
         updated_at = now()
   WHERE risk_budget_usage.consumed + v_units <= v_limit
  RETURNING consumed INTO v_after;

  IF v_after IS NULL THEN
    -- The conflict path's WHERE refused, OR the fresh insert itself exceeded
    -- the limit. Distinguish by reading the committed total.
    SELECT consumed INTO v_after
      FROM risk_budget_usage
     WHERE budget = p_budget AND usage_day = v_today;
    RETURN jsonb_build_object(
      'ok', false, 'budget', p_budget,
      'consumed', COALESCE(v_after, 0), 'limit', v_limit, 'requested', v_units);
  END IF;

  IF v_after > v_limit THEN
    -- The INSERT branch has no WHERE to guard it, so a first spend of the day
    -- larger than the whole budget lands and must be undone. Rare, and the
    -- alternative (a pre-read) is not atomic.
    UPDATE risk_budget_usage
       SET consumed = consumed - v_units, updated_at = now()
     WHERE budget = p_budget AND usage_day = v_today;
    RETURN jsonb_build_object(
      'ok', false, 'budget', p_budget,
      'consumed', v_after - v_units, 'limit', v_limit, 'requested', v_units);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'budget', p_budget,
    'consumed', v_after, 'limit', v_limit, 'requested', v_units);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 6. KILL SWITCHES
-- ══════════════════════════════════════════════════════════════════════════
--
-- A budget is a ceiling that trips on its own. A kill switch is a human
-- deciding, at 03:00, that something is wrong and that the platform should
-- stop issuing credit or stop spending at vendors NOW — without a deploy.
-- Both are needed: the budget catches the attack that is merely large, the
-- switch catches the one nobody has characterised yet.

CREATE TABLE IF NOT EXISTS risk_kill_switches (
  name        TEXT        PRIMARY KEY,
  engaged     BOOLEAN     NOT NULL DEFAULT false,
  reason      TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by  UUID
);

ALTER TABLE risk_kill_switches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admins_select_risk_kill_switches ON risk_kill_switches;
CREATE POLICY admins_select_risk_kill_switches ON risk_kill_switches
  FOR SELECT USING (is_platform_admin());
-- Flipped only through set_risk_kill_switch, which stamps the actor.

-- Seeded disengaged so a reader can see what exists without guessing names.
INSERT INTO risk_kill_switches (name, reason) VALUES
  ('credit_issuance', 'Stops new credit being committed. Existing plans continue to collect.'),
  ('vendor_spend',    'Stops paid KYC, SMS and bureau calls. Signup stalls at the affected step.'),
  ('payouts',         'Holds every merchant payout release.'),
  ('signup',          'Stops new account creation.')
ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE risk_kill_switches IS
  'Platform-wide stop controls (0142). Read by evaluate_risk on every call, '
  'so engaging one takes effect immediately and without a deploy. Flipped '
  'only through set_risk_kill_switch so the change is attributable.';

CREATE OR REPLACE FUNCTION set_risk_kill_switch(
  p_name    TEXT,
  p_engaged BOOLEAN,
  p_actor   UUID,
  p_reason  TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exists BOOLEAN;
BEGIN
  SELECT true INTO v_exists FROM risk_kill_switches WHERE name = p_name;
  IF v_exists IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_switch');
  END IF;

  UPDATE risk_kill_switches
     SET engaged    = p_engaged,
         reason     = COALESCE(p_reason, reason),
         changed_at = now(),
         changed_by = p_actor
   WHERE name = p_name;

  RETURN jsonb_build_object('ok', true, 'name', p_name, 'engaged', p_engaged);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 7. BLOCKS AND HOLDS
-- ══════════════════════════════════════════════════════════════════════════
--
-- The output side of an alert or a review. A reviewer who concludes "this
-- device is a ring" needs somewhere to put that conclusion where the next
-- request will read it, and a tripped circuit breaker needs somewhere to
-- record that this practice's payouts are held.
--
-- One table for both, keyed on (dimension, token), because "hold this
-- practice" and "deny this card fingerprint" are the same operation over the
-- same vocabulary.

CREATE TABLE IF NOT EXISTS risk_blocks (
  dimension  TEXT        NOT NULL,
  token      TEXT        NOT NULL,
  action     TEXT        NOT NULL CHECK (action IN ('friction', 'review', 'deny')),
  reason     TEXT        NOT NULL,
  -- NULL = indefinite. A circuit breaker sets a TTL so a practice is not
  -- silently frozen forever by a Tuesday-afternoon spike.
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  PRIMARY KEY (dimension, token)
);

CREATE INDEX IF NOT EXISTS risk_blocks_expiry_idx ON risk_blocks (expires_at);

ALTER TABLE risk_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admins_select_risk_blocks ON risk_blocks;
CREATE POLICY admins_select_risk_blocks ON risk_blocks
  FOR SELECT USING (is_platform_admin());

COMMENT ON TABLE risk_blocks IS
  'Standing risk decisions per (dimension, token) (0142): reviewer '
  'conclusions and tripped circuit breakers. Consulted by evaluate_risk '
  'before any velocity rule, so a block short-circuits the whole evaluation.';

-- ══════════════════════════════════════════════════════════════════════════
-- 8. evaluate_risk — the one decision call site
-- ══════════════════════════════════════════════════════════════════════════
--
-- ─── WHY THE WHOLE DECISION IS ONE FUNCTION ───────────────────────────────
--
-- Because a decision assembled from N round trips is not a decision. The
-- application would read the device count, read the card count, read the
-- budget, and act — and between any two of those reads a concurrent request
-- from the same ring commits. That is precisely the check-then-act shape
-- A-04 already caught once in this codebase (0130's header), and the answer
-- is the same one: lock, decide and write inside one transaction.
--
-- ─── THE LOCKS ────────────────────────────────────────────────────────────
--
-- Advisory transaction locks on EVERY supplied (dimension, token), taken in
-- sorted order. Sorted because two requests sharing two dimensions in
-- opposite orders would otherwise deadlock; advisory rather than row locks
-- because there is no row to lock — the subject of the lock is a token that
-- may never have been seen before.
--
-- The consequence that matters: two concurrent signups from the same device
-- serialise on that device's lock, so the second one counts the first. Ten
-- concurrent ones serialise the same way. This is the property the audit's
-- "concurrent signup/credit requests" test case is asking for.
--
-- ─── OBSERVE FIRST, THEN COUNT ────────────────────────────────────────────
--
-- The observation rows are written BEFORE the rules are evaluated, so the
-- request being judged is included in its own counts. Two reasons, and the
-- second is the load-bearing one:
--
--   • "This device now has 4 accounts" is the honest statement of what will
--     be true if this request proceeds. Counting 3 and allowing the 4th is
--     off by one in the attacker's favour, every time.
--   • A DENIED attempt still counts. Otherwise refusals are free and a ring
--     can hammer a wall forever without the wall ever getting taller — which
--     is the failure mode that makes most velocity limits decorative.
--
-- ─── ARGUMENTS ────────────────────────────────────────────────────────────
--
--   p_signals  {"device":"<token>","ip":"<token>",…} — dimension → token.
--              Unknown dimensions are dropped with a warning.
--   p_rules    [{"dimension":"device","window_secs":86400,"max_events":20,
--               "max_accounts":3,"action":"review"}, …]
--              A rule with no token in p_signals is skipped, not failed:
--              the caller could not resolve that signal (no cookie yet, no
--              card on file), and refusing on absence would deny every
--              first-time user.
--   p_budgets  [{"budget":"kyc","units":1,"limit":500}, …] Spent only if the
--              rules did not already deny — a refused request costs nothing
--              at the vendor, so it must not spend the vendor budget.
--   p_switches ["vendor_spend","signup"] — which kill switches deny THIS
--              event. Engaging 'payouts' must not stop a patient paying.
--
-- ─── RETURNS ──────────────────────────────────────────────────────────────
--
--   {ok, decision, score, reasons, event_id, review_id}
--
--   decision  'allow'    proceed
--             'friction' proceed only through a step-up the caller offers
--             'review'   hold; a queue row exists
--             'deny'     refuse
--
-- The strongest triggered action wins, and the score is advisory only —
-- nothing branches on it, it exists so a reviewer can sort a queue.

CREATE OR REPLACE FUNCTION evaluate_risk(
  p_event       TEXT,
  p_account_id  UUID,
  p_practice_id UUID,
  p_signals     JSONB,
  p_rules       JSONB,
  p_budgets     JSONB DEFAULT '[]'::jsonb,
  p_switches    JSONB DEFAULT '[]'::jsonb,
  p_amount      NUMERIC DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Ranked so "strongest wins" is an integer comparison rather than a
  -- three-way CASE repeated at every decision point.
  c_rank        CONSTANT JSONB := '{"allow":0,"friction":1,"review":2,"deny":3}'::jsonb;

  v_decision    TEXT := 'allow';
  v_rank        INT  := 0;
  v_score       INT  := 0;
  v_reasons     JSONB := '[]'::jsonb;
  v_signals     JSONB := '{}'::jsonb;
  v_lock_keys   BIGINT[] := ARRAY[]::BIGINT[];
  v_key         BIGINT;
  v_dim         TEXT;
  v_token       TEXT;
  v_rule        JSONB;
  v_budget      JSONB;
  v_budget_res  JSONB;
  v_switch      TEXT;
  v_action      TEXT;
  v_window      INT;
  v_max_events  INT;
  v_max_accts   INT;
  v_events      INT;
  v_accounts    INT;
  v_amount      BIGINT;
  v_event_id    UUID;
  v_review_id   UUID;
  v_block       RECORD;
BEGIN
  IF NOT risk_known_event(p_event) THEN
    -- A typo at a call site. Allow and warn, exactly as 0134 does for an
    -- unknown bucket: refusing would turn a misspelled event name into an
    -- outage on a live surface, and recording it would populate an event
    -- name nothing reviews.
    RAISE WARNING 'evaluate_risk: unknown event %, not evaluating', p_event;
    RETURN jsonb_build_object(
      'ok', true, 'decision', 'allow', 'score', 0,
      'reasons', jsonb_build_array(jsonb_build_object('rule', 'unknown_event')));
  END IF;

  -- Rands → cents once, here, so every amount in the store is an exact
  -- integer and exposure sums never accumulate float error.
  v_amount := (ROUND(COALESCE(p_amount, 0), 2) * 100)::BIGINT;

  -- ── Filter the signals to the declared vocabulary ───────────────────────
  FOR v_dim, v_token IN
    SELECT key, value #>> '{}' FROM jsonb_each(COALESCE(p_signals, '{}'::jsonb))
  LOOP
    IF v_token IS NULL OR v_token = '' THEN
      CONTINUE;
    ELSIF NOT risk_known_dimension(v_dim) THEN
      RAISE WARNING 'evaluate_risk: unknown dimension %, ignoring', v_dim;
    ELSE
      v_signals := v_signals || jsonb_build_object(v_dim, v_token);
    END IF;
  END LOOP;

  -- ── The locks, sorted ───────────────────────────────────────────────────
  SELECT COALESCE(array_agg(k ORDER BY k), ARRAY[]::BIGINT[])
    INTO v_lock_keys
    FROM (
      SELECT DISTINCT hashtextextended(key || ':' || (value #>> '{}'), 0) AS k
        FROM jsonb_each(v_signals)
    ) AS keys;

  FOREACH v_key IN ARRAY v_lock_keys LOOP
    PERFORM pg_advisory_xact_lock(v_key);
  END LOOP;

  -- ── Kill switches ───────────────────────────────────────────────────────
  --
  -- Checked before anything is recorded or spent. An engaged switch is a
  -- human saying stop, and it outranks every rule below.
  FOR v_switch IN SELECT value #>> '{}' FROM jsonb_array_elements(COALESCE(p_switches, '[]'::jsonb))
  LOOP
    IF EXISTS (SELECT 1 FROM risk_kill_switches WHERE name = v_switch AND engaged) THEN
      v_decision := 'deny';
      v_rank     := 3;
      v_score    := 100;
      v_reasons  := v_reasons || jsonb_build_object(
        'rule', 'kill_switch', 'switch', v_switch, 'action', 'deny');
    END IF;
  END LOOP;

  -- ── Standing blocks ─────────────────────────────────────────────────────
  --
  -- A reviewer's conclusion or a tripped breaker. Consulted for every signal,
  -- including ones this event has no velocity rule for: a device blocked
  -- during signup must still be blocked at payout.
  FOR v_dim, v_token IN SELECT key, value #>> '{}' FROM jsonb_each(v_signals) LOOP
    SELECT action, reason INTO v_block
      FROM risk_blocks
     WHERE dimension = v_dim
       AND token = v_token
       AND (expires_at IS NULL OR expires_at > now());
    IF FOUND THEN
      IF (c_rank ->> v_block.action)::INT > v_rank THEN
        v_rank     := (c_rank ->> v_block.action)::INT;
        v_decision := v_block.action;
      END IF;
      v_score   := LEAST(100, v_score + 40);
      v_reasons := v_reasons || jsonb_build_object(
        'rule', 'block', 'dimension', v_dim,
        'action', v_block.action, 'reason', v_block.reason);
    END IF;
  END LOOP;

  -- ── Record the observations ─────────────────────────────────────────────
  --
  -- Before the rules run, so this request is inside its own counts, and
  -- unconditionally, so a refusal still accumulates. See the header.
  INSERT INTO risk_observations (event, dimension, token, account_id, practice_id, amount_cents)
  SELECT p_event, key, value #>> '{}', p_account_id, p_practice_id, v_amount
    FROM jsonb_each(v_signals);

  -- ── The velocity rules ──────────────────────────────────────────────────
  FOR v_rule IN SELECT value FROM jsonb_array_elements(COALESCE(p_rules, '[]'::jsonb)) LOOP
    v_dim   := v_rule ->> 'dimension';
    v_token := v_signals ->> v_dim;

    -- No token for this dimension. The caller could not resolve the signal —
    -- a first visit with no device cookie, a patient with no card on file.
    -- Skip rather than fail: refusing on absence denies every new customer,
    -- which is the "locking out normal patterns" failure the audit warns
    -- about by name. Absence is separately visible in the telemetry the
    -- application emits.
    CONTINUE WHEN v_token IS NULL OR v_token = '';
    CONTINUE WHEN NOT risk_known_dimension(v_dim);

    v_action := COALESCE(v_rule ->> 'action', 'review');
    IF (c_rank ->> v_action) IS NULL THEN v_action := 'review'; END IF;

    -- Clamped, not validated — 0134's argument. A window of a year or a
    -- threshold of zero is a typo, and a limiter that throws on a typo takes
    -- down the surface it guards.
    v_window     := LEAST(GREATEST(COALESCE((v_rule ->> 'window_secs')::INT, 3600), 1), 2592000);
    v_max_events := NULLIF(GREATEST(COALESCE((v_rule ->> 'max_events')::INT, 0), 0), 0);
    v_max_accts  := NULLIF(GREATEST(COALESCE((v_rule ->> 'max_accounts')::INT, 0), 0), 0);

    SELECT count(*), count(DISTINCT account_id)
      INTO v_events, v_accounts
      FROM risk_observations
     WHERE dimension = v_dim
       AND token     = v_token
       AND occurred_at > now() - make_interval(secs => v_window);

    IF v_max_events IS NOT NULL AND v_events > v_max_events THEN
      IF (c_rank ->> v_action)::INT > v_rank THEN
        v_rank := (c_rank ->> v_action)::INT; v_decision := v_action;
      END IF;
      v_score   := LEAST(100, v_score + 20);
      v_reasons := v_reasons || jsonb_build_object(
        'rule', v_dim, 'metric', 'events', 'observed', v_events,
        'threshold', v_max_events, 'window_secs', v_window, 'action', v_action);
    END IF;

    -- The ring signal. One token, many accounts — the thing no per-account
    -- and no per-IP limit can see, and the reason this table exists.
    IF v_max_accts IS NOT NULL AND v_accounts > v_max_accts THEN
      IF (c_rank ->> v_action)::INT > v_rank THEN
        v_rank := (c_rank ->> v_action)::INT; v_decision := v_action;
      END IF;
      v_score   := LEAST(100, v_score + 30);
      v_reasons := v_reasons || jsonb_build_object(
        'rule', v_dim, 'metric', 'accounts', 'observed', v_accounts,
        'threshold', v_max_accts, 'window_secs', v_window, 'action', v_action);
    END IF;
  END LOOP;

  -- ── Budgets ─────────────────────────────────────────────────────────────
  --
  -- Spent last, and only if nothing above refused. A denied request never
  -- reaches the vendor, so charging it against the vendor's daily budget
  -- would let an attacker exhaust the platform's KYC allowance using
  -- requests the platform already rejected.
  IF v_decision <> 'deny' AND v_decision <> 'review' THEN
    FOR v_budget IN SELECT value FROM jsonb_array_elements(COALESCE(p_budgets, '[]'::jsonb)) LOOP
      v_budget_res := consume_risk_budget(
        v_budget ->> 'budget',
        COALESCE((v_budget ->> 'units')::NUMERIC, 1),
        COALESCE((v_budget ->> 'limit')::NUMERIC, 0));
      IF (v_budget_res ->> 'ok')::BOOLEAN IS NOT TRUE THEN
        v_decision := 'deny';
        v_rank     := 3;
        v_score    := 100;
        v_reasons  := v_reasons || jsonb_build_object(
          'rule', 'budget', 'budget', v_budget_res ->> 'budget',
          'observed', v_budget_res -> 'consumed',
          'threshold', v_budget_res -> 'limit', 'action', 'deny');
      END IF;
    END LOOP;
  END IF;

  -- ── Record the decision ─────────────────────────────────────────────────
  --
  -- Allow decisions are not written: normal traffic is the overwhelming
  -- majority, its durable record is risk_observations, and a decision log
  -- that is 99.9% "allow" is a log nobody reads.
  IF v_decision <> 'allow' THEN
    INSERT INTO risk_events (event, decision, score, reasons, account_id, practice_id)
    VALUES (p_event, v_decision, v_score, v_reasons, p_account_id, p_practice_id)
    RETURNING id INTO v_event_id;
  END IF;

  -- ── Open or bump the review ─────────────────────────────────────────────
  --
  -- Deduplicated to one open row per (account, event). A ring hitting the
  -- same wall two hundred times must create one queue item with a hit count,
  -- not two hundred items that bury the one a human needed to see.
  IF v_decision = 'review' THEN
    IF p_account_id IS NOT NULL THEN
      INSERT INTO risk_reviews (event, account_id, practice_id, reasons, score)
      VALUES (p_event, p_account_id, p_practice_id, v_reasons, v_score)
      ON CONFLICT (account_id, event) WHERE state IN ('open', 'in_review') AND account_id IS NOT NULL
      DO UPDATE SET last_hit_at = now(),
                    hit_count   = risk_reviews.hit_count + 1,
                    score       = GREATEST(risk_reviews.score, EXCLUDED.score),
                    reasons     = EXCLUDED.reasons
      RETURNING id INTO v_review_id;
    ELSIF p_practice_id IS NOT NULL THEN
      INSERT INTO risk_reviews (event, account_id, practice_id, reasons, score)
      VALUES (p_event, NULL, p_practice_id, v_reasons, v_score)
      ON CONFLICT (practice_id, event) WHERE state IN ('open', 'in_review') AND account_id IS NULL AND practice_id IS NOT NULL
      DO UPDATE SET last_hit_at = now(),
                    hit_count   = risk_reviews.hit_count + 1,
                    score       = GREATEST(risk_reviews.score, EXCLUDED.score),
                    reasons     = EXCLUDED.reasons
      RETURNING id INTO v_review_id;
    ELSE
      -- Nobody to attach the review to — an anonymous surface with no
      -- account and no practice. Downgrade to friction rather than parking a
      -- decision no human can ever action.
      v_decision := 'friction';
      v_reasons  := v_reasons || jsonb_build_object(
        'rule', 'review_unattachable', 'action', 'friction');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'decision', v_decision,
    'score', v_score,
    'reasons', v_reasons,
    'event_id', v_event_id,
    'review_id', v_review_id);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 9. PER-PRACTICE EXPOSURE AND THE PAYOUT CIRCUIT BREAKER
-- ══════════════════════════════════════════════════════════════════════════
--
-- The merchant half of the loss chain. A colluding or compromised practice
-- does not look unusual one bill at a time — it looks unusual in aggregate:
-- every new customer on the platform this week went to it, its plans default
-- on instalment 2, and it has been paid out for all of them.
--
-- Four numbers, all derivable from tables that already exist:
--
--   open_exposure     uncollected instalments on this practice's live plans
--   window_payout     net rands released to it in the window
--   new_customers     distinct patients who took their FIRST plan here
--   first_payment_ok  fraction of its plans that got past instalment 1
--
-- The last is the sharpest and the cheapest. A healthy practice's plans
-- almost all clear instalment 1 — the customer is standing at the counter.
-- A mule merchant's do not, because the cards are stolen or the customers do
-- not exist. Returned as NULL rather than 1.0 when there is nothing to
-- divide, so a brand-new practice is not read as perfect.

CREATE OR REPLACE FUNCTION practice_risk_posture(
  p_practice_id UUID,
  p_window_days INT DEFAULT 7
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days      INT := LEAST(GREATEST(COALESCE(p_window_days, 7), 1), 365);
  v_since     TIMESTAMPTZ;
  v_exposure  NUMERIC := 0;
  v_payout    NUMERIC := 0;
  v_new       INT := 0;
  v_plans     INT := 0;
  v_cleared   INT := 0;
  v_rate      NUMERIC;
BEGIN
  v_since := now() - make_interval(days => v_days);

  -- Open exposure: everything HNPL has advanced against this practice's
  -- plans and has not yet collected. Mirrors the exposure definition in
  -- 0130's claim_credit_for_plan — uncollected instalments, less the
  -- customer's own excess on instalment 1, which is not credit.
  SELECT COALESCE(SUM(per_plan.uncollected - per_plan.uncollected_excess), 0)
    INTO v_exposure
    FROM (
      SELECT pl.id,
             COALESCE(SUM(pay.amount), 0) AS uncollected,
             CASE WHEN bool_or(pay.instalment_number = 1)
                  THEN COALESCE(pl.excess_amount, 0) ELSE 0 END AS uncollected_excess
        FROM plans pl
        JOIN payments pay
          ON pay.plan_id = pl.id
         AND pay.kind    = 'instalment'
         AND pay.status <> 'collected'
       WHERE pl.practice_id = p_practice_id
         AND pl.status IN ('pending_first_payment', 'active')
       GROUP BY pl.id, pl.excess_amount
    ) AS per_plan;

  SELECT COALESCE(SUM(net_amount), 0) INTO v_payout
    FROM payouts
   WHERE practice_id = p_practice_id
     AND created_at >= v_since;

  -- A patient counts as NEW to the platform, not merely new to this
  -- practice: a ring's value is in fresh identities, and a practice that
  -- receives twenty of them in a week is the signal regardless of where
  -- else they have been.
  SELECT count(DISTINCT pl.patient_id) INTO v_new
    FROM plans pl
   WHERE pl.practice_id = p_practice_id
     AND pl.created_at >= v_since
     AND NOT EXISTS (
       SELECT 1 FROM plans earlier
        WHERE earlier.patient_id = pl.patient_id
          AND earlier.created_at < v_since);

  SELECT count(*) INTO v_plans
    FROM plans pl
   WHERE pl.practice_id = p_practice_id
     AND pl.created_at >= v_since
     AND pl.status IN ('pending_first_payment', 'active', 'completed', 'defaulted');

  SELECT count(*) INTO v_cleared
    FROM plans pl
   WHERE pl.practice_id = p_practice_id
     AND pl.created_at >= v_since
     AND EXISTS (
       SELECT 1 FROM payments pay
        WHERE pay.plan_id = pl.id
          AND pay.kind = 'instalment'
          AND pay.instalment_number = 1
          AND pay.status = 'collected');

  IF v_plans > 0 THEN
    v_rate := ROUND(v_cleared::NUMERIC / v_plans, 4);
  END IF;

  RETURN jsonb_build_object(
    'practice_id',      p_practice_id,
    'window_days',      v_days,
    'open_exposure',    v_exposure,
    'window_payout',    v_payout,
    'new_customers',    v_new,
    'plans_in_window',  v_plans,
    'first_payment_rate', v_rate);
END;
$$;

-- ── trip_practice_circuit_breaker ─────────────────────────────────────────
--
-- Turns a posture reading into a standing hold plus a queue item. Separate
-- from the reading itself so a monitor can watch the numbers without
-- freezing anyone, and so the freeze is one auditable operation.
--
-- The hold is a risk_blocks row on the practice dimension, which means
-- evaluate_risk already enforces it everywhere a practice token is supplied
-- — payouts, counter sessions and plan acceptance alike — without any of
-- those call sites knowing a breaker exists.

CREATE OR REPLACE FUNCTION trip_practice_circuit_breaker(
  p_practice_id UUID,
  p_reason      TEXT,
  p_action      TEXT DEFAULT 'review',
  p_ttl_secs    INT  DEFAULT 604800,
  p_actor       UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action TEXT := COALESCE(p_action, 'review');
  v_ttl    INT  := LEAST(GREATEST(COALESCE(p_ttl_secs, 604800), 60), 7776000);
  v_review UUID;
BEGIN
  IF v_action NOT IN ('friction', 'review', 'deny') THEN
    v_action := 'review';
  END IF;

  INSERT INTO risk_blocks (dimension, token, action, reason, expires_at, created_by)
  VALUES ('practice', p_practice_id::text, v_action, p_reason,
          now() + make_interval(secs => v_ttl), p_actor)
  ON CONFLICT (dimension, token) DO UPDATE
     SET action     = EXCLUDED.action,
         reason     = EXCLUDED.reason,
         -- Extend rather than replace: a breaker that re-trips while already
         -- held must not SHORTEN an existing hold, and an indefinite hold
         -- (expires_at NULL, set by a reviewer) must stay indefinite rather
         -- than being handed this call's TTL.
         expires_at = CASE
           WHEN risk_blocks.expires_at IS NULL THEN NULL
           ELSE GREATEST(risk_blocks.expires_at, EXCLUDED.expires_at)
         END,
         created_by = COALESCE(EXCLUDED.created_by, risk_blocks.created_by);

  INSERT INTO risk_reviews (event, account_id, practice_id, reasons, score)
  VALUES ('payout_release', NULL, p_practice_id,
          jsonb_build_array(jsonb_build_object(
            'rule', 'circuit_breaker', 'reason', p_reason, 'action', v_action)),
          80)
  ON CONFLICT (practice_id, event) WHERE state IN ('open', 'in_review') AND account_id IS NULL AND practice_id IS NOT NULL
  DO UPDATE SET last_hit_at = now(),
                hit_count   = risk_reviews.hit_count + 1
  RETURNING id INTO v_review;

  RETURN jsonb_build_object(
    'ok', true, 'practice_id', p_practice_id,
    'action', v_action, 'review_id', v_review);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 10. DECIDING A REVIEW
-- ══════════════════════════════════════════════════════════════════════════
--
-- The only way a review leaves the queue. Stamps the actor, writes the admin
-- audit trail 0048 established, and — on a rejection — converts the reviewer's
-- conclusion into standing blocks so the next request enforces it.
--
-- Clearing does NOT delete the observations. A cleared account whose device
-- later shows up on nine more accounts must still be countable; forgetting
-- the history because a human said "fine on Tuesday" is how a ring gets a
-- clean slate for the price of one plausible support ticket.

CREATE OR REPLACE FUNCTION decide_risk_review(
  p_review_id UUID,
  p_state     TEXT,
  p_actor     UUID,
  p_notes     TEXT DEFAULT NULL,
  p_blocks    JSONB DEFAULT '[]'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_review RECORD;
  v_block  JSONB;
  v_dim    TEXT;
  v_action TEXT;
BEGIN
  IF p_state NOT IN ('in_review', 'cleared', 'rejected') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state');
  END IF;
  IF p_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'actor_required');
  END IF;

  SELECT * INTO v_review FROM risk_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_review.state IN ('cleared', 'rejected') THEN
    -- Already decided. Refuse rather than re-decide: a second clearance would
    -- overwrite the first reviewer's attribution.
    RETURN jsonb_build_object('ok', false, 'error', 'already_decided',
                              'state', v_review.state);
  END IF;

  UPDATE risk_reviews
     SET state      = p_state,
         notes      = COALESCE(p_notes, notes),
         decided_at = CASE WHEN p_state = 'in_review' THEN NULL ELSE now() END,
         decided_by = CASE WHEN p_state = 'in_review' THEN NULL ELSE p_actor END
   WHERE id = p_review_id;

  -- The reviewer's conclusion, made enforceable.
  FOR v_block IN SELECT value FROM jsonb_array_elements(COALESCE(p_blocks, '[]'::jsonb)) LOOP
    v_dim    := v_block ->> 'dimension';
    v_action := COALESCE(v_block ->> 'action', 'deny');
    CONTINUE WHEN v_dim IS NULL OR NOT risk_known_dimension(v_dim);
    CONTINUE WHEN COALESCE(v_block ->> 'token', '') = '';
    CONTINUE WHEN v_action NOT IN ('friction', 'review', 'deny');

    INSERT INTO risk_blocks (dimension, token, action, reason, expires_at, created_by)
    VALUES (v_dim, v_block ->> 'token', v_action,
            COALESCE(v_block ->> 'reason', 'risk review ' || p_review_id::text),
            CASE WHEN (v_block ->> 'ttl_secs') IS NULL THEN NULL
                 ELSE now() + make_interval(secs => (v_block ->> 'ttl_secs')::INT) END,
            p_actor)
    ON CONFLICT (dimension, token) DO UPDATE
       SET action = EXCLUDED.action, reason = EXCLUDED.reason,
           expires_at = EXCLUDED.expires_at, created_by = EXCLUDED.created_by;
  END LOOP;

  -- 0048's trail. entity_type is constrained to practice/customer, so a
  -- review with neither is recorded against the practice it concerns or,
  -- failing that, not at all — the risk_reviews row itself carries the
  -- attribution in that case.
  IF v_review.account_id IS NOT NULL THEN
    INSERT INTO admin_audit_log (actor_id, entity_type, entity_id, action, payload)
    VALUES (p_actor, 'customer', v_review.account_id, 'risk_review_' || p_state,
            jsonb_build_object('review_id', p_review_id, 'event', v_review.event));
  ELSIF v_review.practice_id IS NOT NULL THEN
    INSERT INTO admin_audit_log (actor_id, entity_type, entity_id, action, payload)
    VALUES (p_actor, 'practice', v_review.practice_id, 'risk_review_' || p_state,
            jsonb_build_object('review_id', p_review_id, 'event', v_review.event));
  END IF;

  RETURN jsonb_build_object('ok', true, 'review_id', p_review_id, 'state', p_state);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 11. RETENTION
-- ══════════════════════════════════════════════════════════════════════════
--
-- POPIA §14: personal information may not be kept longer than is necessary
-- for the purpose it was collected for. The purpose here is detecting
-- coordinated abuse, and abuse coordinates over weeks, not years.
--
--   risk_observations   90 days   the correlation graph. Long enough to see
--                                 a ring that paces itself across a month;
--                                 short enough that it is not a permanent
--                                 record of who shares a household router.
--   risk_events        180 days   decision evidence, needed for disputes and
--                                 for showing a regulator the control fired.
--   risk_blocks       expired     removed once lapsed; they enforce nothing.
--   risk_budget_usage  400 days   aggregate counters with no subject in them
--                                 at all — kept for year-on-year capacity
--                                 planning, and personal in no sense.
--
-- risk_reviews are NOT pruned here. They are decision records about people,
-- and deleting them on a timer would destroy the audit trail that makes the
-- decisions accountable. Their lifecycle belongs with the account's.

CREATE OR REPLACE FUNCTION prune_risk_data(
  p_observation_days INT DEFAULT 90,
  p_event_days       INT DEFAULT 180,
  p_budget_days      INT DEFAULT 400
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_obs    INT;
  v_events INT;
  v_blocks INT;
  v_budget INT;
BEGIN
  DELETE FROM risk_observations
   WHERE occurred_at < now() - make_interval(days => LEAST(GREATEST(COALESCE(p_observation_days, 90), 1), 400));
  GET DIAGNOSTICS v_obs = ROW_COUNT;

  DELETE FROM risk_events
   WHERE occurred_at < now() - make_interval(days => LEAST(GREATEST(COALESCE(p_event_days, 180), 1), 1000));
  GET DIAGNOSTICS v_events = ROW_COUNT;

  DELETE FROM risk_blocks WHERE expires_at IS NOT NULL AND expires_at < now();
  GET DIAGNOSTICS v_blocks = ROW_COUNT;

  DELETE FROM risk_budget_usage
   WHERE usage_day < ((now() AT TIME ZONE 'UTC')::date
                      - LEAST(GREATEST(COALESCE(p_budget_days, 400), 1), 3650));
  GET DIAGNOSTICS v_budget = ROW_COUNT;

  RETURN jsonb_build_object(
    'observations', v_obs, 'events', v_events,
    'blocks', v_blocks, 'budget_days', v_budget);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 12. PRIVILEGES
-- ══════════════════════════════════════════════════════════════════════════
--
-- Service-role only, every one of them, and 0125 made EXECUTE an allow-list
-- so these grants are the whole surface. The lesson 0134's header records
-- about consume_rate_limit applies with more force here: a function that
-- accepts a token and reports how many accounts share it is an oracle, and a
-- function that spends a daily budget is a denial-of-service primitive.
--
-- Nothing is granted to anon or authenticated. Every call site builds a
-- service client (lib/risk/evaluate.ts), exactly as the rate limiter's do.

REVOKE ALL ON FUNCTION risk_known_event(TEXT)     FROM PUBLIC;
REVOKE ALL ON FUNCTION risk_known_dimension(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION risk_known_budget(TEXT)    FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_risk_budget(TEXT, NUMERIC, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION evaluate_risk(TEXT, UUID, UUID, JSONB, JSONB, JSONB, JSONB, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION practice_risk_posture(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION trip_practice_circuit_breaker(UUID, TEXT, TEXT, INT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION decide_risk_review(UUID, TEXT, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_risk_kill_switch(TEXT, BOOLEAN, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION prune_risk_data(INT, INT, INT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION consume_risk_budget(TEXT, NUMERIC, NUMERIC) TO service_role;
    GRANT EXECUTE ON FUNCTION evaluate_risk(TEXT, UUID, UUID, JSONB, JSONB, JSONB, JSONB, NUMERIC) TO service_role;
    GRANT EXECUTE ON FUNCTION practice_risk_posture(UUID, INT) TO service_role;
    GRANT EXECUTE ON FUNCTION trip_practice_circuit_breaker(UUID, TEXT, TEXT, INT, UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION decide_risk_review(UUID, TEXT, UUID, TEXT, JSONB) TO service_role;
    GRANT EXECUTE ON FUNCTION set_risk_kill_switch(TEXT, BOOLEAN, UUID, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION prune_risk_data(INT, INT, INT) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION evaluate_risk(TEXT, UUID, UUID, JSONB, JSONB, JSONB, JSONB, NUMERIC) IS
  'The aggregate fraud decision (0142). Locks every supplied correlation '
  'token, records the observation, evaluates the caller''s velocity rules '
  'across identity, phone, email, IP/subnet/ASN, device, KYC session, card, '
  'bank account, practice and the customer-merchant edge, spends the daily '
  'vendor and credit budgets, and returns allow / friction / review / deny '
  'with the reasons. Thresholds come from lib/risk/policy.ts; this function '
  'clamps and applies them. See audit 2026-09-03 S-07.';
COMMENT ON FUNCTION practice_risk_posture(UUID, INT) IS
  'Per-practice exposure, payout, new-customer and first-payment-rate '
  'metrics for the merchant circuit breaker (0142). Read-only — tripping the '
  'breaker is trip_practice_circuit_breaker.';
COMMENT ON FUNCTION prune_risk_data(INT, INT, INT) IS
  'POPIA retention for the correlation store (0142). Observations 90 days, '
  'decisions 180, expired blocks immediately. Reviews are never pruned here.';
