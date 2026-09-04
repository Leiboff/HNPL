import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());

// ─── Locks the cron config into source ─────────────────────────────────────
//
// vercel.json's schedule string and the 0047 migration are both small
// but load-bearing pieces of the daily-collection pipeline. If anyone
// changes either, these tests fail loudly and prompt a re-review.

describe('vercel.json — cron entries', () => {
  const config = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8'));

  it('declares an array of cron entries', () => {
    expect(Array.isArray(config.crons)).toBe(true);
    expect(config.crons.length).toBeGreaterThanOrEqual(1);
  });

  it('has the collect-instalments cron scheduled 11:00 UTC = 13:00 SAST', () => {
    // Cron format: minute hour day-of-month month day-of-week
    const collect = config.crons.find((c: { path: string }) => c.path === '/api/cron/collect-instalments');
    expect(collect).toBeDefined();
    expect(collect.schedule).toBe('0 11 * * *');
  });

  it('has the risk monitor daily, before the weekly payout batcher closes', () => {
    // 01:00 UTC on a Thursday is three hours before the payout batcher makes
    // a practice's money eligible to leave, so a practice whose first-payment
    // rate collapsed on Wednesday is held BEFORE Thursday's batch exists
    // rather than after.
    const monitor = config.crons.find((c: { path: string }) => c.path === '/api/cron/risk-monitor');
    expect(monitor).toBeDefined();
    expect(monitor.schedule).toBe('0 1 * * *');

    const batcher = config.crons.find((c: { path: string }) => c.path === '/api/cron/payout-batches');
    const monitorHour = Number(monitor.schedule.split(' ')[1]);
    const batcherHour = Number(batcher.schedule.split(' ')[1]);
    expect(monitorHour).toBeGreaterThan(batcherHour);
  });

  it('has the risk alert digest on a sub-hourly cadence', () => {
    // The digest is the only thing that gets a held customer or a stopped
    // payout in front of a person. A daily cadence would mean a ring caught
    // at 02:00 sits unlooked-at until the next morning, so this one has to
    // stay frequent — and a change to it should have to argue with this test.
    const alerts = config.crons.find((c: { path: string }) => c.path === '/api/cron/risk-alerts');
    expect(alerts).toBeDefined();
    expect(alerts.schedule).toMatch(/^\*\/(\d+) \* \* \* \*$/);
    const everyMinutes = Number(alerts.schedule.match(/^\*\/(\d+)/)![1]);
    expect(everyMinutes).toBeLessThanOrEqual(30);
  });

  it('has the CRM reply-poll cron on a daily safety-net cadence (since 0072)', () => {
    // Since 0072 the primary channel is Gmail push (Pub/Sub → the push
    // endpoint). The cron is a once-a-day safety-net sweep + watch
    // renewal. Format: 0 <hour> * * * — matches 06:00 UTC = 08:00 SAST.
    const poll = config.crons.find((c: { path: string }) => c.path === '/api/cron/crm-reply-poll');
    expect(poll).toBeDefined();
    expect(poll.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(poll.schedule).not.toBe('*/15 * * * *');
  });
});

describe('migration 0047 — cron_runs', () => {
  const sql = readFileSync(resolve(ROOT, 'supabase/migrations/0047_cron_runs.sql'), 'utf8');

  it('creates the cron_runs table with the expected columns', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS cron_runs/);
    expect(sql).toMatch(/job_name\s+TEXT/);
    expect(sql).toMatch(/started_at\s+TIMESTAMPTZ/);
    expect(sql).toMatch(/finished_at\s+TIMESTAMPTZ/);
    expect(sql).toMatch(/summary\s+JSONB/);
  });

  it('indexes (job_name, started_at DESC) for "last run" lookups', () => {
    expect(sql).toMatch(/CREATE INDEX[\s\S]*cron_runs\s*\(\s*job_name,\s*started_at\s+DESC\s*\)/);
  });

  it('enables RLS and restricts SELECT to platform admins', () => {
    expect(sql).toMatch(/ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY[\s\S]*ON cron_runs[\s\S]*FOR SELECT[\s\S]*is_platform_admin/);
  });
});
