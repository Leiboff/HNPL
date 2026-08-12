-- ─── Providers on the roster without a login ──────────────────────────────
--
-- WHY THIS EXISTS
-- ───────────────
-- A practice should be able to LIST a practitioner with just a name, a
-- specialty and an HPCSA number. Most practitioners never need to sign in;
-- the practice manager does the billing. Requiring an auth account for every
-- clinician on the roster made "add the third dentist" an email ceremony.
--
-- WHAT WAS ALREADY POSSIBLE, AND WHAT WAS NOT
-- ───────────────────────────────────────────
-- practice_members.user_id has been NULLABLE since 0001 — no NOT NULL was
-- ever added — and UNIQUE (practice_id, user_id) uses the default NULLS
-- DISTINCT, so many login-less rows per practice are already legal. So the
-- row itself was always representable.
--
-- What was missing is somewhere to put the NAME. Names live on profiles,
-- and profiles.id REFERENCES auth.users(id) (0001, ON DELETE CASCADE since
-- 0044) with 0023 auto-creating a profiles row from every auth.users insert.
-- So a profiles row cannot exist without an auth account, which meant a
-- login-less practice_members row would be anonymous.
--
-- This migration adds the two columns that fixes, and nothing else.
--
-- WHY NOT A SEPARATE ROSTER TABLE
-- ───────────────────────────────
-- practice_members already carries role='provider', specialty,
-- hpcsa_number and active, and it is already what checkTradingGate and the
-- new-bill provider picker read. A second table would duplicate the roster
-- and force every consumer to union two sources, with the two drifting the
-- first time someone updated only one of them.
--
-- WHY THIS GRANTS NOTHING
-- ───────────────────────
-- Every authority helper resolves through `user_id = auth.uid()`:
-- is_practice_member / is_practice_admin (0002) and is_practice_manager
-- (0034). A row with user_id IS NULL matches none of them, so a roster row
-- authorises nothing — it cannot sign in, cannot be signed in AS, and grants
-- no read. That is an invariant of the existing predicates rather than a new
-- rule this migration has to invent or police.
--
-- The roster row is still READABLE by the practice's managers, because the
-- SELECT policy is practice-scoped and not user-scoped:
-- practice_admins_select_members USING is_practice_manager(practice_id)
-- (0035, replacing 0002's is_practice_admin version). Confirmed by reading
-- it, because a user_id-scoped policy would have made the roster invisible.
--
-- PURELY ADDITIVE. No column is dropped, no row is modified, no policy
-- changes, and no existing member data is migrated.

-- ── 1. Names for roster rows ────────────────────────────────────────────
--
-- Only ever populated when user_id IS NULL. For a member WITH a login the
-- name stays on profiles, which remains the single source of truth for a
-- person who has an account — these columns must not become a second place
-- to store the name of someone who already has one. The CHECK in step 2 is
-- what makes that structural rather than a convention.

ALTER TABLE practice_members
  ADD COLUMN IF NOT EXISTS provider_first_name TEXT,
  ADD COLUMN IF NOT EXISTS provider_last_name  TEXT;

-- ── 2. Every row must be identifiable ───────────────────────────────────
--
-- A row is identifiable if it has a linked account (name on profiles) OR
-- carries both of its own name parts. The failure this prevents is a row
-- with neither: nameless, loginless, and impossible to tell apart from
-- another one on the Team screen.
--
-- It also forbids the reverse — local names on a row that HAS a user_id —
-- so the name of a person with an account can only ever live in one place.
--
-- Validates clean against existing data: every current row has user_id set
-- and both name columns NULL, which satisfies the first branch. Added as a
-- normal (validated) constraint deliberately, so if that assumption is
-- wrong anywhere this migration fails loudly instead of leaving a table
-- that violates its own invariant.

ALTER TABLE practice_members
  DROP CONSTRAINT IF EXISTS practice_members_identifiable;

ALTER TABLE practice_members
  ADD CONSTRAINT practice_members_identifiable CHECK (
    (user_id IS NOT NULL
       AND provider_first_name IS NULL
       AND provider_last_name  IS NULL)
    OR
    (user_id IS NULL
       AND provider_first_name IS NOT NULL AND btrim(provider_first_name) <> ''
       AND provider_last_name  IS NOT NULL AND btrim(provider_last_name)  <> '')
  );

-- ── 3. Roster lookups ───────────────────────────────────────────────────
--
-- The two queries this feature adds: "which rows on this practice have no
-- login yet" (the Team screen's invite affordance) and the per-practice
-- roster read. Partial, because rows WITH a login are the majority and are
-- never the answer to either question.

CREATE INDEX IF NOT EXISTS practice_members_roster_idx
  ON practice_members (practice_id, active)
  WHERE user_id IS NULL;

-- ── 4. Comments ─────────────────────────────────────────────────────────

COMMENT ON COLUMN practice_members.provider_first_name IS
  'First name for a roster row with NO login (user_id IS NULL). Must be NULL when user_id is set — profiles is the single source of truth for anyone who has an account. Enforced by practice_members_identifiable.';
COMMENT ON COLUMN practice_members.provider_last_name IS
  'Surname for a roster row with NO login. See provider_first_name.';
COMMENT ON CONSTRAINT practice_members_identifiable ON practice_members IS
  'Every membership row is identifiable: either a linked account (name on profiles) or its own non-blank first+last name, never both and never neither.';
