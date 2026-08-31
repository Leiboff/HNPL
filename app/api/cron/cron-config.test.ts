import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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

  it('has the CRM reply-poll cron on a daily safety-net cadence (since 0072)', () => {
    // Since 0072 the primary channel is Gmail push (Pub/Sub → the push
    // endpoint). The cron is a once-a-day safety-net sweep + watch
    // renewal. Format: 0 <hour> * * * — matches 06:00 UTC = 08:00 SAST.
    const poll = config.crons.find((c: { path: string }) => c.path === '/api/cron/crm-reply-poll');
    expect(poll).toBeDefined();
    expect(poll.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(poll.schedule).not.toBe('*/15 * * * *');
  });

  it('has the onboarding-nudge cron on a short cadence', () => {
    // Unlike the other three, this one is about PROMPTNESS: the first
    // nudge goes to a patient who has been idle five minutes, so the poll
    // interval is the precision of that promise. Correctness does not
    // depend on it — the cohort is re-read at send time, so a longer
    // interval just means a later email. If the deployment plan will not
    // run this every five minutes, widen it here and the pin with it.
    const nudge = config.crons.find((c: { path: string }) => c.path === '/api/cron/onboarding-nudge');
    expect(nudge).toBeDefined();
    expect(nudge.schedule).toMatch(/^\*\/\d+ \* \* \* \*$/);
  });

  it('every declared cron has a route on disk', () => {
    // A path typo in vercel.json is a job that silently never runs: Vercel
    // requests the URL, Next returns 404, and nothing anywhere complains.
    for (const cron of config.crons as { path: string }[]) {
      // The cron path is a URL; the handler lives under app/.
      const route = resolve(ROOT, `app${cron.path}/route.ts`);
      expect(existsSync(route), `${cron.path} has no route.ts`).toBe(true);
    }
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
