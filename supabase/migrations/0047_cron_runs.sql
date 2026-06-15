-- ─── cron_runs: observability for scheduled jobs ──────────────────────────
--
-- Daily-scheduled jobs (starting with the installment collection cron
-- in /api/cron/collect-instalments) write a record per run. The summary
-- column carries a JSON breakdown — for the collection job that's:
--
--   {
--     "started_at":        "...",
--     "finished_at":       "...",
--     "written_off_count": N,
--     "eligible_count":    N,
--     "charged_count":     N,
--     "claim_lost_count":  N,
--     "transport_errors":  N
--   }
--
-- The shape is intentionally JSON rather than a fixed column set so we
-- can add new jobs (retry-cleanup, payout-reconciliation, whatever)
-- without a schema change per job.
--
-- A cron that silently stops running is a money-not-collected disaster,
-- so the admin portal will query this table to show "last run at: ..."
-- per job. The job_name + started_at DESC index gives the lookup an
-- index seek.

CREATE TABLE IF NOT EXISTS cron_runs (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name     TEXT         NOT NULL,
  started_at   TIMESTAMPTZ  NOT NULL,
  finished_at  TIMESTAMPTZ,
  summary      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cron_runs_job_started_idx
  ON cron_runs (job_name, started_at DESC);

-- RLS: only platform admins can read. The cron route writes via the
-- service-role client which bypasses RLS — no INSERT policy needed.
ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins_select_cron_runs" ON cron_runs
  FOR SELECT
  USING (is_platform_admin());

COMMENT ON TABLE  cron_runs IS
  'One row per scheduled-job invocation. Summary JSON varies per job_name.';
COMMENT ON COLUMN cron_runs.job_name IS
  'Identifier for the job (e.g. ''collect-instalments''). Stable across runs.';
COMMENT ON COLUMN cron_runs.summary IS
  'Job-specific counts / outcomes. See lib/payments/chargeInstalment.ts.';
