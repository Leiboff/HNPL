-- ─── payouts SELECT: manager-level → member-level ─────────────────────────
--
-- WHY
-- ───
-- payout_batches (0090) is readable by any active practice member;
-- payouts was readable only by a member with can_manage_practice. That
-- asymmetry is visible to users: a practice could see the TOTAL of a weekly
-- payout batch but not which plans made it up, so the "from N plans"
-- breakdown showed a count above an empty list for anyone but a manager.
--
-- The two tables describe one thing — money owed to this practice for plans it
-- activated — so one audience is correct. This aligns payouts with
-- payout_batches rather than the reverse, because the batch total is the
-- number a practice reconciles against its bank statement and hiding its
-- composition from the person doing the reconciling is the wrong default.
--
-- POLICY HISTORY, since the obvious answer is out of date
-- ──────────────────────────────────────────────────────
--   0002  practice_admins_select_payouts  USING is_practice_admin(...)
--           → an active member with role = 'admin'
--   0035  same NAME, re-created with is_practice_manager(...)
--           → an active member with can_manage_practice = true
--   here  replaced by practice_members_select_payouts
--           USING is_practice_member(...) → any active member
--
-- The policy is RENAMED because the old name has been wrong since 0035 (it
-- said "admins" while checking a capability) and would be wronger still now.
-- A policy whose name contradicts its predicate is how the next person
-- reasons incorrectly about who can read a money table.
--
-- SELECT ONLY
-- ───────────
-- No INSERT, UPDATE or DELETE policy is added, altered or dropped. For the
-- record, the complete write surface on payouts stays exactly as it was:
--   0002  admins_all_payouts               FOR ALL    is_platform_admin()
--   0009  patients_insert_payout_on_accept FOR INSERT (patient accepting a plan)
-- There is NO practice-side write policy on payouts and this migration does
-- not create one, so a member — manager or not — still cannot write a payout.
-- The runner and the settle actions write with service-role, which bypasses
-- RLS entirely and is unaffected either way.
--
-- Left untouched, and still in force alongside the new policy (RLS policies
-- are permissive/OR'd, so these keep granting what they always did):
--   0022  provider_select_own_payouts      provider_id = auth.uid()
--   0061  brand_admin_select_branch_payouts is_brand_admin_of_practice(...)
--
-- ⚠️ WHAT ELSE THIS EXPOSES — READ BEFORE ASSUMING THIS IS ONLY ABOUT AMOUNTS
-- ─────────────────────────────────────────────────────────────────────────
-- RLS is ROW-level, not COLUMN-level. Widening the row predicate widens access
-- to EVERY COLUMN of those rows, and payouts still carries five columns that
-- captured a PROVIDER'S PERSONAL BANK DETAILS at activation time, from when
-- payout_destination could be 'provider':
--
--   snapshot_bank_name, snapshot_account_holder, snapshot_account_number,
--   snapshot_branch_code, snapshot_account_type
--
-- The feature that wrote them is gone and nothing populates them any more, but
-- the columns deliberately REMAIN so historical rows stay auditable (0090).
-- So after this migration, any active member of a practice — reception
-- included — can read those columns on any historical row of that practice
-- that has them.
--
-- This migration proceeds anyway, because widening to member-level is the
-- decision being implemented and the exposure is bounded to rows that already
-- exist. It is recorded here, at the point of change, so that:
--   • scripts/check-payout-snapshot-exposure.ts can establish whether any row
--     actually holds such data (run it; it is read-only), and
--   • if the answer is non-zero, the correct fix is a column-restricted VIEW
--     for the practice-facing read, NOT a narrower row predicate — the same
--     reasoning migration 0064 applied to the patient-facing practitioners
--     directory.
-- Do not silently drop this note if the columns are later cleared: the columns
-- being readable is a property of this policy, not of today's data.

DROP POLICY IF EXISTS "practice_admins_select_payouts"  ON payouts;
DROP POLICY IF EXISTS "practice_members_select_payouts" ON payouts;

CREATE POLICY "practice_members_select_payouts"
  ON payouts
  FOR SELECT
  USING (is_practice_member(practice_id));

COMMENT ON POLICY "practice_members_select_payouts" ON payouts IS
  'Any ACTIVE member of the practice may read its payouts, matching payout_batches (0090) so a practice can see what makes up a weekly batch total. Replaced practice_admins_select_payouts, which checked is_practice_manager since 0035 despite its name. SELECT only — there is no practice-side write policy on payouts.';
