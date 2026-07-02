-- ─── Approved credit limit + passkey-prompt frequency cap ─────────────
--
-- Two orthogonal additions to `profiles`, both landing here so the
-- new home-dashboard build ships in one migration:
--
--   1. approved_credit_limit — a per-patient credit ceiling used by the
--      home-page "approved balance" widget. Nullable (no limit set →
--      widget doesn't render). Written by service-role / admin only —
--      patient session writes are blocked by the 0054 column-lock trigger
--      (updated here to include this column).
--
--   2. login_count / passkey_prompt_next_show_at_login /
--      passkey_prompt_permanent_dismiss — frequency-cap machinery for the
--      new full-sheet post-login passkey prompt. The prompt shows on the
--      first login after signup; if the user hits "Skip", it re-shows at
--      most every 3rd subsequent login; if they hit "Don't ask again",
--      it never re-shows. Complements (does not replace) the existing
--      passkey_prompt_dismissed_at / _count columns from 0037 — those
--      stay for the OLD home-page nudge card during the rollout window
--      and can be dropped in a future cleanup.
--
-- No CHECK constraint changes on OLD columns; new constraints are
-- non-narrowing (only additive).

-- ── 1. approved_credit_limit ──────────────────────────────────────────

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS approved_credit_limit NUMERIC(10,2);

COMMENT ON COLUMN profiles.approved_credit_limit IS
  'Per-patient credit ceiling. NULL when no limit is set — the home '
  'dashboard widget then does not render. Set by admin / service-role '
  'only; user-initiated writes are rejected by the 0054 column-lock '
  'trigger. Future credit-check flows populate this; there is no '
  'automatic assessment yet.';

-- ── 2. Passkey-prompt frequency cap ───────────────────────────────────

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS login_count                     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS passkey_prompt_next_show_at_login INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS passkey_prompt_permanent_dismiss  BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN profiles.login_count IS
  'Total successful logins since signup. Incremented by the login-'
  'landing server action. Used by the post-login passkey prompt to '
  'implement "show every 3rd login until skipped or dismissed".';

COMMENT ON COLUMN profiles.passkey_prompt_next_show_at_login IS
  'The login_count value at which the post-login passkey prompt is '
  'next allowed to render. Defaults to 1 (show on first login). Bumped '
  'to (login_count + 3) when the user hits Skip.';

COMMENT ON COLUMN profiles.passkey_prompt_permanent_dismiss IS
  'True when the user hit "Don''t ask again". The prompt is never '
  'shown after this flips to true.';

-- ── 3. Extend the 0054 column-lock to include approved_credit_limit ──
--
-- The lock uses the same bypass posture as 0054 (service_role OR the
-- `app.privileged_write = on` set_config from a SECURITY DEFINER RPC).
-- The three new passkey-cap columns are DELIBERATELY NOT locked — the
-- patient's session client updates them via the existing prompt
-- server actions. Only approved_credit_limit is a privileged write.

CREATE OR REPLACE FUNCTION protect_profiles_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role'
     OR current_setting('app.privileged_write', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION
      'profiles.role is not user-editable (privilege escalation guard)';
  END IF;

  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION
      'profiles.email must be changed via the auth.users email-change ceremony';
  END IF;

  IF NEW.phone_verified_at IS DISTINCT FROM OLD.phone_verified_at THEN
    RAISE EXCEPTION
      'profiles.phone_verified_at is set only by the OTP verification path';
  END IF;

  IF NEW.approved_credit_limit IS DISTINCT FROM OLD.approved_credit_limit THEN
    RAISE EXCEPTION
      'profiles.approved_credit_limit is admin-set only (service-role / privileged RPC)';
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger is unchanged from 0054 (BEFORE UPDATE); the function above
-- swaps in the new body.

COMMENT ON FUNCTION protect_profiles_columns() IS
  'Column-lock for profiles. Rejects user-initiated writes to role / '
  'email / phone_verified_at / approved_credit_limit. Bypassed for '
  'service-role and for SECURITY DEFINER RPCs that opt in via '
  'set_config(''app.privileged_write'', ''on'', true). See migration '
  '0054 header for rationale; 0065 added approved_credit_limit.';
