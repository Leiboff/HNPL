-- Track the patient-portal one-shot prompt that nudges a user to register
-- a passkey after first login. We re-prompt at most once after 30 days, so
-- we need both the last-dismissal timestamp and a count to know whether
-- we've already used our single follow-up.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS passkey_prompt_dismissed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS passkey_prompt_dismissed_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN profiles.passkey_prompt_dismissed_at IS
  'Timestamp of the patient''s most recent passkey-prompt dismissal. NULL = never dismissed.';

COMMENT ON COLUMN profiles.passkey_prompt_dismissed_count IS
  'How many times the patient has dismissed the passkey prompt. Capped by app logic at 2 (initial + one re-prompt after 30 days).';
