-- ─── Audit trail for the practices.status transition ──────────────────────
--
-- Before this migration, practices.status flipped to 'approved' only via
-- manual DB edits (no app code did it). With the admin-portal approval
-- queue landing alongside this migration, the platform admin clicks a
-- button — we want to know WHICH admin approved each practice and WHEN
-- for both audit and any future POPIA / compliance review.
--
--   approved_at   : timestamptz set on the pending → approved transition.
--                   Stays NULL on rows that have never been approved.
--                   We do NOT clear it on a later suspend / re-approve;
--                   the audit trail keeps the first-approval timestamp.
--                   (If we later need an approval history we'll add a
--                   separate practice_status_events table — out of scope.)
--   approved_by   : the auth.uid() of the admin who clicked Approve.
--                   Nullable so historic / legacy rows can stay clean.
--
-- Purely additive: ADD COLUMN IF NOT EXISTS. No existing rows touched.

ALTER TABLE practices
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES profiles(id);

COMMENT ON COLUMN practices.approved_at IS
  'Timestamp when an admin first flipped status pending → approved.';
COMMENT ON COLUMN practices.approved_by IS
  'profiles.id of the platform admin who approved this practice.';
