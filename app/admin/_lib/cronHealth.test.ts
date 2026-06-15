import { describe, it, expect } from 'vitest';
import { classifyCronHealth, type CronRunRow, COLLECT_INSTALMENTS_HOUR_UTC } from './cronHealth';

// ─── Cron-health classification tests ───────────────────────────────────────
//
// The dashboard's cron-health card is the operator's "is the collection
// engine alive?" signal. These tests pin the three-state classifier:
//
//   GREEN — last run within 25h AND no transport_errors AND no written_off
//   AMBER — no run since today's expected 11:00 UTC slot, OR no runs ever
//   RED   — last run had transport_errors > 0 OR written_off_count > 0
//
// Priority when more than one condition could trigger: AMBER over RED
// (if the engine isn't running, "errors in last run" matters less than
// "no recent run at all").

// Fix "now" to a UTC moment that's past today's 11:00 slot — most tests
// run with the assumption that today's run was expected by now.
const FIXED_NOW = new Date('2026-06-15T14:00:00Z'); // 14:00 UTC, well past 11:00 slot

// Build a synthetic cron_runs row N hours BEFORE the test's `now`
// (defaults to FIXED_NOW). Without this the row would be relative to
// real Date.now() — months off from the fixed "now" the classifier
// is given, breaking every offset.
function row(opts: {
  hoursAgo:        number;
  transportErrors?: number;
  writtenOff?:      number;
  charged?:         number;
  eligible?:        number;
  claimLost?:       number;
  now?:            Date;
}): CronRunRow {
  const baseMs = (opts.now ?? FIXED_NOW).getTime();
  const startedAt = new Date(baseMs - opts.hoursAgo * 60 * 60 * 1000).toISOString();
  return {
    started_at:  startedAt,
    finished_at: new Date(baseMs - opts.hoursAgo * 60 * 60 * 1000 + 5000).toISOString(),
    summary: {
      eligible_count:    opts.eligible    ?? 0,
      charged_count:     opts.charged     ?? 0,
      claim_lost_count:  opts.claimLost   ?? 0,
      transport_errors:  opts.transportErrors ?? 0,
      written_off_count: opts.writtenOff  ?? 0,
    },
  };
}

describe('classifyCronHealth — AMBER cases', () => {
  it('returns AMBER when there are no cron_runs rows at all', () => {
    const h = classifyCronHealth(null, FIXED_NOW);
    expect(h.state).toBe('amber');
    expect(h.label).toMatch(/no cron runs/i);
  });

  it("returns AMBER when today's 11:00 UTC slot has passed AND last run is before it", () => {
    // Last run was yesterday at 11:01 UTC — 27 hours ago.
    const h = classifyCronHealth(row({ hoursAgo: 27, charged: 5, eligible: 5 }), FIXED_NOW);
    expect(h.state).toBe('amber');
    expect(h.label).toMatch(/hasn.t run today/i);
  });

  it('AMBER takes priority over RED — no run today wins even if last run had errors', () => {
    const h = classifyCronHealth(
      row({ hoursAgo: 27, transportErrors: 2 }),
      FIXED_NOW,
    );
    expect(h.state).toBe('amber');
  });
});

describe('classifyCronHealth — RED cases', () => {
  it('returns RED when last run is recent AND transport_errors > 0', () => {
    // Last run 3h ago (today, after the slot) with one transport error.
    const h = classifyCronHealth(row({ hoursAgo: 3, transportErrors: 1, charged: 5 }), FIXED_NOW);
    expect(h.state).toBe('red');
    expect(h.label).toMatch(/transport error/i);
  });

  it('returns RED when last run wrote off rows (cap-exhausted)', () => {
    const h = classifyCronHealth(row({ hoursAgo: 3, writtenOff: 2, charged: 4 }), FIXED_NOW);
    expect(h.state).toBe('red');
    expect(h.label).toMatch(/written off/i);
  });

  it('combines both flags in the label when both > 0', () => {
    const h = classifyCronHealth(row({ hoursAgo: 3, transportErrors: 1, writtenOff: 2 }), FIXED_NOW);
    expect(h.state).toBe('red');
    expect(h.label).toMatch(/transport/i);
    expect(h.label).toMatch(/written off/i);
  });
});

describe('classifyCronHealth — GREEN cases', () => {
  it("returns GREEN when last run is recent and clean", () => {
    const h = classifyCronHealth(row({ hoursAgo: 3, charged: 10, eligible: 10 }), FIXED_NOW);
    expect(h.state).toBe('green');
    expect(h.charged).toBe(10);
    expect(h.eligible).toBe(10);
  });

  it("returns GREEN when last run was yesterday's 11:00 UTC and current time is BEFORE today's slot", () => {
    // Current "now" is at 09:00 UTC — today's 11:00 slot hasn't happened
    // yet, so a 22-hour-old run from yesterday's slot is fine.
    const beforeSlotNow = new Date('2026-06-15T09:00:00Z');
    const h = classifyCronHealth(row({ hoursAgo: 22, now: beforeSlotNow }), beforeSlotNow);
    expect(h.state).toBe('green');
  });
});

describe('classifyCronHealth — surface counts inline', () => {
  it('threads charged / eligible / written_off / transport / claim_lost into the result', () => {
    const h = classifyCronHealth(
      row({ hoursAgo: 3, charged: 8, eligible: 10, claimLost: 1, writtenOff: 0, transportErrors: 0 }),
      FIXED_NOW,
    );
    expect(h.charged).toBe(8);
    expect(h.eligible).toBe(10);
    expect(h.failed).toBe(1);
    expect(h.writtenOff).toBe(0);
    expect(h.transportErrors).toBe(0);
  });
});

describe('COLLECT_INSTALMENTS_HOUR_UTC matches the vercel.json schedule', () => {
  it('is 11 (matches "0 11 * * *")', () => {
    expect(COLLECT_INSTALMENTS_HOUR_UTC).toBe(11);
  });
});
