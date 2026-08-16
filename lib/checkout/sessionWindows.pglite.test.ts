// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── The scan window and the completion window, against real Postgres ────
//
// "A scanned session survives past the scan window" is a claim about what
// two SQL functions do to a row, so it is tested by running the SHIPPED
// function definitions against a real Postgres and driving them — not by
// asserting that an INTERVAL literal appears in a file.
//
// It matters more than usual here because the failure mode is silent and
// terminal: expire_stale_checkout_session does not merely lapse a link, it
// sets plans.status = 'declined'. Before this split, a first-time patient
// at a counter who took longer than two minutes had their bill destroyed.

const ROOT = resolve(process.cwd());

/** The shipped definition, sliced out of the migration that owns it. */
function fn(file: string, name: string): string {
  const sql   = readFileSync(resolve(ROOT, 'supabase/migrations', file), 'utf8');
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  const end = sql.indexOf('$$;', start);
  if (end < 0) throw new Error(`unterminated body for ${name}`);
  return sql.slice(start, end + 3);
}

const EXPIRE = fn('0085_checkout_sessions.sql', 'expire_stale_checkout_session');
const STAMP  = fn('0098_invitation_sa_id_and_completion_window.sql', 'stamp_checkout_session_scanned');

// Only what the two functions touch.
const SCHEMA = `
  create table plans (
    id     uuid primary key,
    status text not null
  );
  create table checkout_sessions (
    id           uuid primary key default gen_random_uuid(),
    token        text unique not null,
    plan_id      uuid not null references plans(id),
    stage        text not null default 'created',
    created_at   timestamptz not null default now(),
    scanned_at   timestamptz,
    expires_at   timestamptz not null
  );
`;

let db: PGlite;

/** A live session whose deadline is `secondsFromNow` away. */
async function seed(secondsFromNow: number, stage = 'created'): Promise<{ token: string; planId: string }> {
  const planId = randomUUID();
  const token  = randomUUID().replace(/-/g, '');
  await db.query(`insert into plans (id, status) values ($1, 'pending_acceptance')`, [planId]);
  await db.query(
    `insert into checkout_sessions (token, plan_id, stage, expires_at)
     values ($1, $2, $3, now() + make_interval(secs => $4))`,
    [token, planId, stage, secondsFromNow],
  );
  return { token, planId };
}

const planStatus = async (planId: string): Promise<string> =>
  ((await db.query(`select status from plans where id = $1`, [planId])).rows[0] as { status: string }).status;

const session = async (token: string) =>
  (await db.query(
    `select stage, scanned_at, extract(epoch from (expires_at - now())) as secs_left
       from checkout_sessions where token = $1`,
    [token],
  )).rows[0] as { stage: string; scanned_at: string | null; secs_left: number };

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(EXPIRE);
  await db.exec(STAMP);
});

beforeEach(async () => {
  await db.exec('delete from checkout_sessions; delete from plans;');
});

describe('the SCAN window still bites', () => {
  it('an UNSCANNED QR past its window declines the plan', async () => {
    const { token, planId } = await seed(-1);
    await db.query(`select expire_stale_checkout_session($1)`, [token]);

    expect(await planStatus(planId)).toBe('declined');
    expect((await session(token)).stage).toBe('expired');
  });

  it('an unscanned QR INSIDE its window is left alone', async () => {
    const { token, planId } = await seed(60);
    await db.query(`select expire_stale_checkout_session($1)`, [token]);

    expect(await planStatus(planId)).toBe('pending_acceptance');
    expect((await session(token)).stage).toBe('created');
  });

  it('scanning an ALREADY-EXPIRED QR does not revive it', async () => {
    // Otherwise a dead code could be resurrected simply by scanning it,
    // which would make the scan window advisory.
    const { token, planId } = await seed(-1);
    await db.query(`select stamp_checkout_session_scanned($1)`, [token]);

    expect(await planStatus(planId)).toBe('declined');
    expect((await session(token)).stage).toBe('expired');
  });
});

describe('scanning moves the deadline to the COMPLETION window', () => {
  it('a 10-second-from-expiry QR gets about an hour once scanned', async () => {
    const { token } = await seed(10);
    await db.query(`select stamp_checkout_session_scanned($1)`, [token]);

    const s = await session(token);
    expect(s.stage).toBe('scanned');
    expect(s.scanned_at).toBeTruthy();
    // Comfortably more than the scan window it replaced, and not open-ended.
    expect(Number(s.secs_left)).toBeGreaterThan(55 * 60);
    expect(Number(s.secs_left)).toBeLessThanOrEqual(60 * 60);
  });

  it('a first-time signup taking 20+ minutes still completes', async () => {
    // The case that used to destroy the bill. Scan with seconds left on the
    // scan clock, then advance the world 25 minutes and confirm nothing
    // declines it — the patient can still pay.
    const { token, planId } = await seed(10);
    await db.query(`select stamp_checkout_session_scanned($1)`, [token]);

    // 25 minutes later.
    await db.query(
      `update checkout_sessions set expires_at = expires_at - interval '25 minutes' where token = $1`,
      [token],
    );
    await db.query(`select expire_stale_checkout_session($1)`, [token]);

    expect(await planStatus(planId)).toBe('pending_acceptance');
    expect((await session(token)).stage).toBe('scanned');

    // And the plan can still reach a terminal success from here.
    await db.query(`update plans set status = 'active' where id = $1`, [planId]);
    expect(await planStatus(planId)).toBe('active');
  });

  it('but the completion window is NOT open-ended — an hour later it still expires', async () => {
    const { token, planId } = await seed(10);
    await db.query(`select stamp_checkout_session_scanned($1)`, [token]);
    await db.query(
      `update checkout_sessions set expires_at = now() - interval '1 second' where token = $1`,
      [token],
    );
    await db.query(`select expire_stale_checkout_session($1)`, [token]);

    expect(await planStatus(planId)).toBe('declined');
    expect((await session(token)).stage).toBe('expired');
  });

  it('scanning does not touch the plan — only the decliner writes plans.status', async () => {
    const { token, planId } = await seed(60);
    await db.query(`select stamp_checkout_session_scanned($1)`, [token]);
    expect(await planStatus(planId)).toBe('pending_acceptance');
  });
});

describe('an explicit abandon is still immediate', () => {
  it('"Start next patient" force-expires a session inside its window', async () => {
    const { token, planId } = await seed(60);
    await db.query(`select expire_stale_checkout_session($1, true)`, [token]);

    expect(await planStatus(planId)).toBe('declined');
    expect((await session(token)).stage).toBe('expired');
  });

  it('and force-expires a SCANNED one too, mid-completion-window', async () => {
    // A teller explicitly abandoning is a different event from a timeout.
    // Widening the completion window must not make that unavailable.
    const { token, planId } = await seed(10);
    await db.query(`select stamp_checkout_session_scanned($1)`, [token]);
    await db.query(`select expire_stale_checkout_session($1, true)`, [token]);

    expect(await planStatus(planId)).toBe('declined');
  });

  it('force does NOT resurrect or re-decline a completed session', async () => {
    const { token, planId } = await seed(60);
    await db.query(`update checkout_sessions set stage = 'completed' where token = $1`, [token]);
    await db.query(`update plans set status = 'active' where id = $1`, [planId]);
    await db.query(`select expire_stale_checkout_session($1, true)`, [token]);

    expect(await planStatus(planId)).toBe('active');
    expect((await session(token)).stage).toBe('completed');
  });
});

describe('one decliner, still', () => {
  it('the scan stamp contains no write to plans at all', async () => {
    expect(STAMP).not.toMatch(/update\s+plans/i);
    expect(STAMP).toMatch(/select expire_stale_checkout_session\(p_token\)/i);
  });

  it('a plan already past the pending stages is never declined by a stale session', async () => {
    const { token, planId } = await seed(-1);
    await db.query(`update plans set status = 'active' where id = $1`, [planId]);
    await db.query(`select expire_stale_checkout_session($1)`, [token]);

    expect(await planStatus(planId)).toBe('active');
  });
});
