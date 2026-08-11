-- ─── till_devices.user_agent — capture the registering device's model ────
--
-- 0088 gave till_devices a manager-assigned `label` (friendly name) but no
-- way to see WHICH physical device a row is — every till showed as
-- "Unnamed till" and the model was never captured. This adds the raw
-- User-Agent string, captured from the browser at registration
-- (app/practice/pos/register → redeemDeviceRegistrationCode), so a manager
-- can tell devices apart by model (e.g. a Samsung "SM-S911B") as well as by
-- the name they typed.
--
-- Stored RAW (source of truth); parsed to a friendly model label only at
-- display time (lib/auth/deviceModel.ts's describeDevice) so the mapping can
-- improve without a backfill. Nullable: a device registered before this
-- column, or a client that sent no UA, simply shows "Unknown device".
--
-- NOT a secret and NOT security-bearing — it's set alongside `label` via the
-- service-role client in the redeem action (same write path that already
-- mints the row), so no new RLS is needed. The existing 0088 manager
-- SELECT/UPDATE policies already cover every column on this table row-wise.

ALTER TABLE till_devices
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

COMMENT ON COLUMN till_devices.user_agent IS
  'Raw browser User-Agent captured at device registration '
  '(app/practice/pos/register). Source of truth for the device model shown '
  'to managers; parsed to a friendly label at display time by '
  'lib/auth/deviceModel.ts (describeDevice). Nullable — legacy rows or a '
  'client that sent no UA display as "Unknown device". Not a secret; set '
  'together with the manager-assigned label by redeemDeviceRegistrationCode '
  'via the service-role client, so no RLS change is required.';
