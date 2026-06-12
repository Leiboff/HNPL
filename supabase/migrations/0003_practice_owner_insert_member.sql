-- Allow the practice owner to insert the initial practice_members row.
--
-- The existing "practice_admins_insert_members" policy uses is_practice_admin(),
-- which checks for a pre-existing admin row in practice_members. That creates a
-- chicken-and-egg problem: the very first membership row cannot be inserted
-- because no membership row exists yet to satisfy the check.
--
-- This policy breaks the cycle by letting the owner of the practice (identified
-- via practices.owner_id) insert a membership row for their own practice.

CREATE POLICY "owners_insert_own_membership" ON practice_members
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM practices
            WHERE practices.id = practice_members.practice_id
              AND practices.owner_id = auth.uid()
        )
    );
