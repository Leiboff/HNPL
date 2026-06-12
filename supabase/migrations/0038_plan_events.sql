-- Append-only timeline of significant changes per payment plan.
-- Used for audit / future risk analysis. Writes are server-side only
-- (via the change_default_card SECURITY DEFINER function in 0038);
-- patients can read their own events; admins see everything.

CREATE TABLE IF NOT EXISTS plan_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     UUID        NOT NULL REFERENCES plans(id)    ON DELETE CASCADE,
  patient_id  UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL CHECK (event_type IN ('collection_card_changed')),
  payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_events_plan_id_created_at_idx
  ON plan_events (plan_id, created_at DESC);

CREATE INDEX IF NOT EXISTS plan_events_patient_id_idx
  ON plan_events (patient_id);

ALTER TABLE plan_events ENABLE ROW LEVEL SECURITY;

-- Patients can read their own plan events.
DROP POLICY IF EXISTS patients_read_own_plan_events ON plan_events;
CREATE POLICY patients_read_own_plan_events ON plan_events
  FOR SELECT USING (patient_id = auth.uid());

-- Admins can do anything.
DROP POLICY IF EXISTS admins_all_plan_events ON plan_events;
CREATE POLICY admins_all_plan_events ON plan_events
  FOR ALL  USING (is_platform_admin())
       WITH CHECK (is_platform_admin());

-- No explicit INSERT / UPDATE / DELETE policies for patients — events are
-- written only by SECURITY DEFINER functions (change_default_card in
-- migration 0038). Anonymous role has no access by default.
