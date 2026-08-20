-- Add payments.dunning_grace_until — the 24-hour self-pay window before a
-- default fee posts.
--
-- Direct product decision: a failed collection attempt no longer earns its
-- Default Fee immediately. The patient gets a day to settle manually (Pay
-- now) before the fee attaches — T&Cs clause 7.5 already permits us to
-- "waive or defer any Default Fee" at our discretion, so this is a policy
-- layer on top of the disclosed ladder (lib/payments/dunning.ts), not a
-- change to what clause 7.2/7.3 promise as the worst case.
--
-- Set by the Peach webhook's payment.failure handler the moment an
-- attempt fails (today + 1 day). Cleared once the fee decision is
-- finalised — either by the daily cron's fee-assessment pass (see
-- lib/payments/assessDunningFee.ts) or, on the happy path, by the patient
-- paying within the window (the payment.success handler clears it too).
--
-- NULL means "no fee decision pending" — either nothing has failed yet,
-- or the pending decision has already been resolved.

ALTER TABLE payments
    ADD COLUMN dunning_grace_until DATE;

COMMENT ON COLUMN payments.dunning_grace_until IS
  'Date on/after which a still-unpaid failed instalment''s Default Fee '
  'may be assessed (set to the failed-attempt date + 1 day). NULL when '
  'no fee decision is pending. See lib/payments/assessDunningFee.ts.';

-- RLS note: no new policy required. This column is only ever written by
-- the service-role webhook and cron; the existing patient-facing SELECT
-- policies already expose whatever columns they list explicitly, so this
-- addition is invisible to session clients unless a page's own select
-- string names it.
