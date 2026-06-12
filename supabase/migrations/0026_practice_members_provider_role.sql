-- practice_members.role previously allowed only 'admin'/'staff'. Add 'provider'
-- for healthcare providers. practice_members.role uses short values
-- ('admin','provider','staff'); this is distinct from profiles.role which uses
-- 'practice_admin'/'practice_provider'. is_practice_admin() checks role='admin'.
ALTER TABLE practice_members DROP CONSTRAINT IF EXISTS practice_members_role_check;
ALTER TABLE practice_members ADD CONSTRAINT practice_members_role_check
  CHECK (role IN ('admin', 'staff', 'provider'));
