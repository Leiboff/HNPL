-- Allow practice owners to select and delete their own practice rows.
--
-- SELECT: required so the setup page can detect an orphaned practice (a practice
--         row that exists but has no corresponding practice_members row), which
--         can happen when the practices insert succeeds but the practice_members
--         insert fails mid-setup. Without this, the owner cannot see their own
--         practice until they are already a member — a chicken-and-egg problem.
--
-- DELETE: required so the setup Server Action can roll back a practice row when
--         the subsequent practice_members insert fails, preventing orphaned rows
--         from accumulating across retried submissions.

CREATE POLICY "owners_select_own_practice" ON practices
    FOR SELECT
    USING (owner_id = auth.uid());

CREATE POLICY "owners_delete_own_practice" ON practices
    FOR DELETE
    USING (owner_id = auth.uid());
