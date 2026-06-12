-- A practice admin needs to read the profiles of providers/members in their
-- own practice (e.g. to populate the provider dropdown on the bill form).
-- Uses is_practice_admin() (SECURITY DEFINER, no RLS recursion).
CREATE POLICY "practice_admin_select_member_profiles"
  ON profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM practice_members target_member
      WHERE target_member.user_id = profiles.id
        AND is_practice_admin(target_member.practice_id)
    )
  );
