-- ─── profiles: invert the column lock from deny-list to allow-list ──────
--
-- THE DEFECT (audit 2026-09-01, F-05)
--
-- 0054 introduced protect_profiles_columns() as a DENY-LIST: role, email,
-- phone_verified_at. 0065 added approved_credit_limit. Those four are
-- genuinely locked — verified against real Postgres as a non-superuser.
--
-- Every other column stayed writable by the row's owner under
-- users_update_own_profile. Which is fine for `first_name`, and not fine
-- at all for the seven columns that decide whether somebody may take
-- credit. lib/onboarding/state.ts::stepIsSatisfied reads:
--
--     phone_verified_at     ← locked by 0054
--     sa_id_number          ← NOT locked
--     liveness_verified_at  ← NOT locked
--     salary_day            ← NOT locked
--     salary_amount         ← NOT locked
--     credit_check_status   ← NOT locked
--
-- and computeOnboarding short-circuits to {done:true} on
--
--     onboarding_completed  ← NOT locked
--
-- before evaluating any of them. So one request finished onboarding:
--
--     PATCH /rest/v1/profiles?id=eq.<self>
--     {"onboarding_completed":true}
--
-- and one request forged the whole identity record, sa_id_lookup_hash
-- included — which meant the 0097 one-ID-per-account unique index was
-- satisfied with a fresh random value per account, defeating the
-- duplicate-account control in the same statement that defeated identity.
--
-- No Didit session, no DHA registry match, no face match, no bureau call.
-- requireOnboarded() — the server-side gate on acceptPlan and
-- payWithSavedCard — then passes.
--
-- The comment in state.ts said "Neither can be set by the patient typing
-- into a form." True of the form. Not true of PostgREST, which the patient
-- can reach with the bundled anon key and their own cookie.
--
-- WHY AN ALLOW-LIST
--
-- A deny-list has to be extended every time a column is added, and F-05 is
-- exactly what happens when someone forgets: 0102-0105 added five identity
-- columns and none of them was added to the lock. The list below is derived
-- from every non-privileged UPDATE that actually exists in the tree —
-- enumerated, not guessed:
--
--   app/provider/profile/page.tsx        phone
--   app/provider/setup/page.tsx          must_change_password  (browser client)
--   app/patient/passkey-actions.ts       login_count,
--                                        passkey_prompt_next_show_at_login,
--                                        passkey_prompt_permanent_dismiss,
--                                        passkey_prompt_dismissed_at
--
-- Everything else that writes profiles already holds the service-role
-- client: the Didit webhook, lib/onboarding/actions.ts (all six actions),
-- checkout's profile upsert, the phone-change promotion, signUpPatient's
-- acceptance stamp, /auth/callback, and — as of this commit —
-- saveSalaryDay / saveSalaryAmount, which moved to service-role rather than
-- being allow-listed. Their validators (isAllowedSalaryDay /
-- isValidSalaryAmount) are the reason: a column a patient can PATCH is a
-- column whose validator is decorative, and salary_amount feeds the
-- affordability step.
--
-- first_name / last_name are allow-listed. No surface edits them today, but
-- they are display strings rather than identity — the identity binding is
-- the DHA registry match and the face score — and locking a column with no
-- writer buys nothing while risking a break.
--
-- The comparison is done over to_jsonb(NEW) vs to_jsonb(OLD) rather than
-- column by column, so a column added in a future migration is locked by
-- DEFAULT. That is the whole point of the inversion: the next person to add
-- an identity column does not have to remember this file exists.

CREATE OR REPLACE FUNCTION protect_profiles_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- The ONLY columns a user session may change on its own row.
  patient_writable CONSTANT text[] := ARRAY[
    'first_name',
    'last_name',
    'phone',
    'must_change_password',
    'login_count',
    'passkey_prompt_next_show_at_login',
    'passkey_prompt_permanent_dismiss',
    'passkey_prompt_dismissed_at',
    'passkey_prompt_dismissed_count'
  ];
  blocked text;
BEGIN
  IF hnpl_write_is_privileged() THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(n.key, ', ' ORDER BY n.key)
    INTO blocked
    FROM jsonb_each(to_jsonb(NEW)) AS n
   WHERE NOT (n.key = ANY (patient_writable))
     AND n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);

  IF blocked IS NOT NULL THEN
    -- Names the columns rather than just refusing: the failure mode this
    -- replaces was a silent zero-rows-affected, and a developer who adds a
    -- legitimate new patient-editable column needs to be told which one to
    -- add to the array above rather than left guessing.
    RAISE EXCEPTION
      'profiles: these columns are not user-editable and were modified: %. '
      'Identity, affordability and onboarding state are server-set — write them '
      'through the service-role client or a privileged RPC (audit F-05).', blocked;
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger unchanged from 0054 (BEFORE UPDATE FOR EACH ROW); this swaps the
-- body. Re-created defensively in case an environment is missing it.
DROP TRIGGER IF EXISTS trg_protect_profiles_columns ON profiles;
CREATE TRIGGER trg_protect_profiles_columns
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION protect_profiles_columns();

COMMENT ON FUNCTION protect_profiles_columns() IS
  'ALLOW-LIST column lock for profiles (0122, replacing 0054/0065''s '
  'deny-list). A user session may change only first/last name, phone, '
  'must_change_password and the passkey-prompt counters. Everything else — '
  'role, email, every identity / liveness / credit / salary / onboarding '
  'column, and any column added in future — is refused unless '
  'hnpl_write_is_privileged(). See audit F-05.';

-- ── Upper bound on salary_amount ───────────────────────────────────────
--
-- saveSalaryAmount now writes through the privileged client, which means
-- the trigger bypasses it and isValidSalaryAmount() in the action is the
-- only thing between a caller and the column. 0005 and 0100 already pin
-- salary_day to 1-31 and salary_amount to > 0; neither has a ceiling, so a
-- declared income of R10^12 is currently storable. It feeds the
-- affordability step, so the bound belongs in the schema rather than only
-- in a validator someone has to remember to call.
--
-- NOT VALID: existing rows are not re-validated, so a legacy row outside
-- the bound stays readable and stays fixable. Run VALIDATE CONSTRAINT once
-- the data is known clean.

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_salary_amount_ceiling;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_salary_amount_ceiling
  CHECK (salary_amount IS NULL OR salary_amount <= 10000000) NOT VALID;
