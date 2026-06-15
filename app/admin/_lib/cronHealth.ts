// ─── Cron health classification ─────────────────────────────────────────────
//
// A cron that silently stops running is a money-not-collected disaster.
// The dashboard surfaces a single GREEN / AMBER / RED chip for the
// collect-instalments job. This module is the canonical classifier so
// the dashboard card and the cron-runs detail page agree on the
// signal.
//
// Priority (most urgent first):
//   AMBER  — no run since today's expected slot. The engine has
//            stopped firing. Investigate first; if the cron isn't
//            running, none of the other counts matter.
//   RED    — the last run completed but recorded transport_errors > 0
//            OR written_off_count > 0. transport_errors are a real
//            failure mode (Paystack unreachable). written_off rows
//            are an expected business outcome at the retry cap, but
//            the brief calls for them to surface red — they represent
//            money we've given up on, and any change in cadence is
//            worth noticing.
//   GREEN  — last run was within ~25 hours AND had no errors and no
//            write-offs.
//
// The cron schedule is 11:00 UTC daily. "Today's expected slot has
// passed" is checked as "current UTC time is at or after 11:00 UTC
// today AND the last run's started_at is before 11:00 UTC today".
// This avoids flipping amber during the legitimate ~22-hour gap
// between yesterday's run and today's run.

export const COLLECT_INSTALMENTS_HOUR_UTC = 11;

export type CronHealth = {
  state:   'green' | 'amber' | 'red';
  label:   string;
  detail:  string;
  // Useful counts pulled out so the card can show them inline.
  lastRunStartedAt:   string | null;
  charged:            number;
  failed:             number;
  writtenOff:         number;
  transportErrors:    number;
  eligible:           number;
};

type RunSummary = {
  charged_count?:     number;
  claim_lost_count?:  number;
  transport_errors?:  number;
  written_off_count?: number;
  eligible_count?:    number;
};

export type CronRunRow = {
  started_at:  string;
  finished_at: string | null;
  summary:     RunSummary | null;
};

export function classifyCronHealth(
  lastRun: CronRunRow | null,
  now: Date = new Date(),
): CronHealth {
  // No run ever recorded → engine has never fired (or the table was
  // wiped). AMBER not RED — there's no error to surface, just no signal.
  if (!lastRun) {
    return {
      state:            'amber',
      label:            'No cron runs yet',
      detail:           'The daily collection job has not recorded a run. Investigate before the next salary cycle.',
      lastRunStartedAt: null,
      charged:          0,
      failed:           0,
      writtenOff:       0,
      transportErrors:  0,
      eligible:         0,
    };
  }

  const summary = lastRun.summary ?? {};
  const charged         = Number(summary.charged_count    ?? 0);
  const failed          = Number(summary.claim_lost_count ?? 0); // surface as "failed/skipped"
  const writtenOff      = Number(summary.written_off_count ?? 0);
  const transportErrors = Number(summary.transport_errors ?? 0);
  const eligible        = Number(summary.eligible_count   ?? 0);

  // "Today's expected slot has passed AND the last run was before it."
  const todaysSlot = new Date(now);
  todaysSlot.setUTCHours(COLLECT_INSTALMENTS_HOUR_UTC, 0, 0, 0);
  const slotHasPassed   = now.getTime() >= todaysSlot.getTime();
  const lastRunTime     = new Date(lastRun.started_at);
  const lastRunBeforeSlot = lastRunTime.getTime() < todaysSlot.getTime();
  const missedTodaysRun = slotHasPassed && lastRunBeforeSlot;

  if (missedTodaysRun) {
    return {
      state:            'amber',
      label:            "Hasn't run today",
      detail:           `Today's 11:00 UTC slot passed without a run. Last run was at ${formatUtc(lastRun.started_at)}.`,
      lastRunStartedAt: lastRun.started_at,
      charged, failed, writtenOff, transportErrors, eligible,
    };
  }

  if (transportErrors > 0 || writtenOff > 0) {
    const bits: string[] = [];
    if (transportErrors > 0) bits.push(`${transportErrors} transport error${transportErrors === 1 ? '' : 's'}`);
    if (writtenOff > 0)      bits.push(`${writtenOff} written off`);
    return {
      state:            'red',
      label:            bits.join(', '),
      detail:           `Last run at ${formatUtc(lastRun.started_at)} surfaced issues — review cron runs.`,
      lastRunStartedAt: lastRun.started_at,
      charged, failed, writtenOff, transportErrors, eligible,
    };
  }

  return {
    state:            'green',
    label:            'Healthy',
    detail:           `Last run at ${formatUtc(lastRun.started_at)} — ${charged} charged, ${eligible} eligible.`,
    lastRunStartedAt: lastRun.started_at,
    charged, failed, writtenOff, transportErrors, eligible,
  };
}

function formatUtc(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
