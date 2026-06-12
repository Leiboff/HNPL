-- RLS policies for multi-tenant provider model.
-- Adds provider-scoped access and practice-admin member management.

-- ─── PLANS: providers see their own ──────────────────────────────────────────

CREATE POLICY "provider_select_own_plans" ON plans
  FOR SELECT
  USING (provider_id = auth.uid());

-- ─── PAYOUTS: providers see their own ────────────────────────────────────────

CREATE POLICY "provider_select_own_payouts" ON payouts
  FOR SELECT
  USING (provider_id = auth.uid());

-- ─── PROFILES: providers read/update their own row ───────────────────────────
-- (A generic "users own their profile" policy may already exist; these are
--  scoped by role to avoid conflicts if it does not.)

CREATE POLICY "provider_select_own_profile" ON profiles
  FOR SELECT
  USING (id = auth.uid());

-- UPDATE is intentionally broad here — the server action enforces which fields
-- can be changed (phone only for providers).
CREATE POLICY "provider_update_own_profile" ON profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ─── PRACTICE_MEMBERS: admins manage their practice's members ────────────────

CREATE POLICY "practice_admin_manage_members" ON practice_members
  FOR ALL
  USING (
    practice_id IN (
      SELECT pm.practice_id FROM practice_members pm
      WHERE pm.user_id = auth.uid() AND pm.role = 'practice_admin'
    )
  )
  WITH CHECK (
    practice_id IN (
      SELECT pm.practice_id FROM practice_members pm
      WHERE pm.user_id = auth.uid() AND pm.role = 'practice_admin'
    )
  );

-- ─── PATIENT_INVITATIONS: admins insert invitations for their practice ────────

CREATE POLICY "practice_admin_insert_invitations"
  ON patient_invitations FOR INSERT
  WITH CHECK (
    practice_id IN (
      SELECT pm.practice_id FROM practice_members pm
      WHERE pm.user_id = auth.uid() AND pm.role = 'practice_admin'
    )
  );
