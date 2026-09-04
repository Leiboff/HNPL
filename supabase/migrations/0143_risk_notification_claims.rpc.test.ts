// @vitest-environment node
//
// ─── Exactly-once notification claims ─────────────────────────────────────
//
// The property under test is narrow and it is the whole reason 0143 exists:
// an operator must be told about each finding ONCE.
//
// Both failure directions cost something, and they cost differently:
//
//   DUPLICATE  Two overlapping cron runs both send. Somebody is woken twice
//              at 03:00, writes a mail rule on day two, and the real page
//              lands in a folder nobody reads. Not recoverable — the cost is
//              paid in whether anyone still looks.
//   LOST       A crash between the claim and the send drops one digest. The
//              rows are still in risk_events, still on /admin/risk, and the
//              next digest carries anything new. Recoverable.
//
// So the design stamps BEFORE sending, and this file pins that choice along
// with the release path that recovers the one failure worth recovering.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG_0142 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0142_fraud_risk_controls.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const MIG_0143 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0143_risk_notification_claims.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const SCHEMA = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create or replace function is_platform_admin() returns boolean language sql stable as $$ select false $$;

  create table profiles (id uuid primary key);
  create table practices (id uuid primary key);
  create table plans (
    id uuid primary key, patient_id uuid, practice_id uuid,
    total_amount numeric(10,2), excess_amount numeric(10,2) not null default 0,
    status text, created_at timestamptz not null default now());
  create table payments (
    id uuid primary key, plan_id uuid, patient_id uuid, instalment_number int,
    amount numeric(10,2), status text, kind text not null default 'instalment');
  create table payouts (
    id uuid primary key, practice_id uuid, plan_id uuid,
    net_amount numeric(10,2), created_at timestamptz not null default now());
  create table admin_audit_log (
    id uuid primary key default gen_random_uuid(), actor_id uuid not null,
    entity_type text not null check (entity_type in ('practice','customer')),
    entity_id uuid not null, action text not null,
    payload jsonb not null default '{}'::jsonb, created_at timestamptz default now());
`;

const uuid = (n: number) => {
  const h = n.toString(16).padStart(4, '0');
  return `0000${h}-0000-0000-0000-0000000${h}0`;
};

const ADMIN = uuid(9999);

type Claim = {
  reviews: Array<{ id: string; event: string; score: number; hit_count: number }>;
  events: Array<{ id: string; event: string; decision: string }>;
  switches: Array<{ name: string }>;
  budgets: Array<{ budget: string; consumed: string | number }>;
};

let db: PGlite;

async function claim(maxReviews = 100, maxEvents = 200): Promise<Claim> {
  const { rows } = await db.query<{ c: Claim }>(
    `select claim_risk_notifications($1, $2) as c`, [maxReviews, maxEvents]);
  return rows[0].c;
}

/**
 * Sign up accounts `from`..`to` on one shared device, under a rule that
 * allows one account per device — so every account after the first is held
 * and gets a review.
 *
 * The range is explicit rather than a count, and that matters: re-running
 * account 1 after account 2 has been seen legitimately opens a review for
 * account 1 too, because by then it IS sharing a device with somebody. A
 * helper that always restarted at 1 would make the tests below assert the
 * wrong numbers for the right reason.
 */
async function holdRange(from: number, to: number): Promise<void> {
  const rules = JSON.stringify([
    { dimension: 'device', window_secs: 3600, max_accounts: 1, action: 'review' },
  ]);
  for (let i = from; i <= to; i += 1) {
    await db.query(
      `select evaluate_risk('signup', $1::uuid, null, '{"device":"dev-A"}'::jsonb,
                            $2::jsonb, '[]'::jsonb, '[]'::jsonb, 0)`,
      [uuid(i), rules],
    );
  }
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG_0142);
  await db.exec(MIG_0143);
  await db.query('insert into profiles (id) values ($1)', [ADMIN]);
  for (let i = 1; i <= 30; i += 1) {
    await db.query('insert into profiles (id) values ($1)', [uuid(i)]);
  }
});

afterEach(async () => {
  await db.close();
});

describe('the claim is exactly-once', () => {
  it('returns un-notified reviews and decisions on the first call', async () => {
    await holdRange(1, 3);
    const first = await claim();
    // Accounts 2 and 3 were held; account 1 was the first sighting.
    expect(first.reviews).toHaveLength(2);
    expect(first.events).toHaveLength(2);
  });

  it('returns nothing on a second call — no duplicate page', async () => {
    await holdRange(1, 3);
    await claim();
    const second = await claim();
    expect(second.reviews).toEqual([]);
    expect(second.events).toEqual([]);
  });

  it('picks up only what is new since the last claim', async () => {
    await holdRange(1, 2);
    expect((await claim()).reviews).toHaveLength(1);

    await holdRange(3, 4);
    const next = await claim();
    expect(next.reviews).toHaveLength(2);
    expect(next.reviews.every((r) => r.event === 'signup')).toBe(true);
  });

  it('stamps notified_at on exactly the rows it returned', async () => {
    await holdRange(1, 3);
    const claimed = await claim();
    const { rows } = await db.query<{ c: string }>(
      `select count(*)::text as c from risk_reviews where notified_at is not null`);
    expect(Number(rows[0].c)).toBe(claimed.reviews.length);
  });

  it('does not re-notify a review that was only re-hit', async () => {
    // A ring hammering one wall two hundred times must produce one email,
    // not two hundred. 0142 bumps hit_count on the existing open review;
    // 0143 must not treat that as new.
    await holdRange(1, 2);
    await claim();
    // The SAME account, over and over. 0142 bumps hit_count on its open
    // review rather than opening another, so nothing new is claimable.
    for (let i = 0; i < 20; i += 1) await holdRange(2, 2);
    const next = await claim();
    expect(next.reviews).toEqual([]);

    const { rows } = await db.query<{ hit_count: number }>(
      `select max(hit_count) as hit_count from risk_reviews`);
    expect(rows[0].hit_count).toBe(21);
  });

  it('does not notify a review that was decided before the digest ran', async () => {
    // Somebody already dealt with it. Reporting it would be asking them to
    // look at their own work.
    await holdRange(1, 2);
    const { rows } = await db.query<{ id: string }>(`select id from risk_reviews limit 1`);
    await db.query(
      `select decide_risk_review($1::uuid, 'cleared', $2::uuid, null, '[]'::jsonb)`,
      [rows[0].id, ADMIN]);
    const claimed = await claim();
    expect(claimed.reviews).toEqual([]);
    // The DECISION that opened it is still reported — the finding happened,
    // whatever was concluded about it afterwards.
    expect(claimed.events).toHaveLength(1);
  });

  it('respects the per-digest caps and leaves the rest for the next run', async () => {
    await holdRange(1, 11);
    const first = await claim(5, 5);
    expect(first.reviews).toHaveLength(5);
    expect(first.events).toHaveLength(5);
    const second = await claim(100, 100);
    expect(second.reviews).toHaveLength(5);
  });

  it('returns the worst reviews first, so a capped digest carries the important ones', async () => {
    await holdRange(1, 4);
    // Raise one review's score above the others.
    await db.query(`update risk_reviews set score = 95 where account_id = $1`, [uuid(3)]);
    const claimed = await claim(2, 200);
    expect(claimed.reviews[0].score).toBe(95);
  });
});

describe('conditions are reported every time, not claimed', () => {
  it('reports an engaged kill switch on every digest while it is engaged', async () => {
    await db.query(`select set_risk_kill_switch('payouts', true, $1::uuid, 'incident')`, [ADMIN]);
    expect((await claim()).switches.map((s) => s.name)).toEqual(['payouts']);
    // Again. A condition that went quiet while still true would be the
    // worst possible behaviour for a stop that is refusing customers.
    expect((await claim()).switches.map((s) => s.name)).toEqual(['payouts']);
  });

  it('stops reporting a switch once released', async () => {
    await db.query(`select set_risk_kill_switch('payouts', true, $1::uuid, 'x')`, [ADMIN]);
    await db.query(`select set_risk_kill_switch('payouts', false, $1::uuid, 'resolved')`, [ADMIN]);
    expect((await claim()).switches).toEqual([]);
  });

  it("reports today's budget consumption every time", async () => {
    await db.query(`select consume_risk_budget('kyc', 40, 500)`);
    expect(Number((await claim()).budgets[0].consumed)).toBe(40);
    expect(Number((await claim()).budgets[0].consumed)).toBe(40);
  });

  it('does not report a previous day’s budget row', async () => {
    await db.query(`select consume_risk_budget('kyc', 40, 500)`);
    await db.query(`update risk_budget_usage set usage_day = usage_day - 1`);
    expect((await claim()).budgets).toEqual([]);
  });
});

describe('release puts a failed batch back', () => {
  it('clears notified_at so the next digest carries it again', async () => {
    await holdRange(1, 3);
    const claimed = await claim();
    expect(claimed.reviews.length).toBeGreaterThan(0);

    const { rows } = await db.query<{ r: { reviews: number; events: number } }>(
      `select release_risk_notifications($1::uuid[], $2::uuid[]) as r`,
      [claimed.reviews.map((r) => r.id), claimed.events.map((e) => e.id)],
    );
    expect(rows[0].r.reviews).toBe(claimed.reviews.length);
    expect(rows[0].r.events).toBe(claimed.events.length);

    const again = await claim();
    expect(again.reviews).toHaveLength(claimed.reviews.length);
    expect(again.events).toHaveLength(claimed.events.length);
  });

  it('is a no-op on empty arrays rather than releasing everything', async () => {
    // The guard that stops a release call with no ids from re-sending the
    // entire history.
    await holdRange(1, 3);
    await claim();
    const { rows } = await db.query<{ r: { reviews: number; events: number } }>(
      `select release_risk_notifications('{}'::uuid[], '{}'::uuid[]) as r`);
    expect(rows[0].r).toEqual({ reviews: 0, events: 0 });
    expect((await claim()).reviews).toEqual([]);
  });
});

describe('lockdown', () => {
  it('grants the claim functions to service_role only', () => {
    for (const fn of ['claim_risk_notifications', 'release_risk_notifications']) {
      expect(MIG_0143).toContain(`REVOKE ALL ON FUNCTION ${fn}(`);
    }
    // A function that hands back every un-notified risk decision is a
    // read surface over the whole queue; a function that clears the stamps
    // is a way to flood the operator's mailbox.
    expect(MIG_0143).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*\banon\b/);
    expect(MIG_0143).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*\bauthenticated\b/);
  });

  it('indexes only the un-notified rows', () => {
    // The claim predicate. A full index on two growing tables to serve a
    // tiny shrinking set would be almost entirely dead weight.
    expect(MIG_0143).toMatch(/risk_events_unnotified_idx[\s\S]*WHERE notified_at IS NULL/);
    expect(MIG_0143).toMatch(/risk_reviews_unnotified_idx[\s\S]*WHERE notified_at IS NULL/);
  });
});
