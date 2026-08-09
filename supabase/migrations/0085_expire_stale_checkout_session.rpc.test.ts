// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Real RPC execution test — expire_stale_checkout_session (Build C) ────
//
// Source-text pins (pos-session-flow.test.ts) prove the SQL *says* the
// right thing; this proves the function *does* the right thing,
// including the race-safety property that's impossible to verify by
// reading source alone: a concurrent activateFirstInstalment must always
// win over this function's decline decision. Loads the ACTUAL function
// body out of the migration file and runs it in an in-process Postgres
// (pglite, real plpgsql) against a minimal schema.

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0085_checkout_sessions.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

function fnSql(name: string): string {
  const start = MIG.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  if (start < 0) throw new Error(`function ${name} not found in migration`);
  const end = MIG.indexOf('$$;', start);
  return MIG.slice(start, end + 3);
}

const SCHEMA = `
  create table plans (
    id     uuid primary key default gen_random_uuid(),
    status text not null
  );
  create table checkout_sessions (
    id           uuid primary key default gen_random_uuid(),
    token        text unique not null,
    plan_id      uuid not null,
    stage        text not null default 'created',
    expires_at   timestamptz not null,
    confirmed_by uuid,
    confirmed_at timestamptz
  );
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(fnSql('expire_stale_checkout_session'));
  return db;
}

async function seed(
  db: PGlite,
  opts: { token: string; planStatus: string; stage: string; expiresAt: string },
): Promise<string> {
  const plan = await db.query<{ id: string }>(
    `insert into plans (status) values ($1) returning id`,
    [opts.planStatus],
  );
  const planId = plan.rows[0].id;
  await db.query(
    `insert into checkout_sessions (token, plan_id, stage, expires_at) values ($1, $2, $3, $4)`,
    [opts.token, planId, opts.stage, opts.expiresAt],
  );
  return planId;
}

async function planStatus(db: PGlite, planId: string): Promise<string> {
  const r = await db.query<{ status: string }>(`select status from plans where id = $1`, [planId]);
  return r.rows[0].status;
}
async function sessionStage(db: PGlite, token: string): Promise<string> {
  const r = await db.query<{ stage: string }>(`select stage from checkout_sessions where token = $1`, [token]);
  return r.rows[0].stage;
}

const PAST   = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60_000).toISOString();

describe('expire_stale_checkout_session — natural expiry (p_force=false)', () => {
  let db: PGlite;
  beforeEach(async () => { db = await freshDb(); });

  it('declines the plan + expires the session once expires_at has passed', async () => {
    const planId = await seed(db, { token: 't1', planStatus: 'pending_acceptance', stage: 'created', expiresAt: PAST });
    await db.query(`select expire_stale_checkout_session($1, false)`, ['t1']);
    expect(await planStatus(db, planId)).toBe('declined');
    expect(await sessionStage(db, 't1')).toBe('expired');
  });

  it('also closes a session abandoned mid-capture (pending_first_payment)', async () => {
    const planId = await seed(db, { token: 't2', planStatus: 'pending_first_payment', stage: 'scanned', expiresAt: PAST });
    await db.query(`select expire_stale_checkout_session($1, false)`, ['t2']);
    expect(await planStatus(db, planId)).toBe('declined');
    expect(await sessionStage(db, 't2')).toBe('expired');
  });

  it('is a no-op while the session has NOT actually expired yet', async () => {
    const planId = await seed(db, { token: 't3', planStatus: 'pending_acceptance', stage: 'created', expiresAt: FUTURE });
    await db.query(`select expire_stale_checkout_session($1, false)`, ['t3']);
    expect(await planStatus(db, planId)).toBe('pending_acceptance');
    expect(await sessionStage(db, 't3')).toBe('created');
  });
});

describe('expire_stale_checkout_session — explicit abandonment (p_force=true)', () => {
  let db: PGlite;
  beforeEach(async () => { db = await freshDb(); });

  it('declines immediately even though expires_at is still in the future ("Start next patient")', async () => {
    const planId = await seed(db, { token: 't4', planStatus: 'pending_acceptance', stage: 'created', expiresAt: FUTURE });
    await db.query(`select expire_stale_checkout_session($1, true)`, ['t4']);
    expect(await planStatus(db, planId)).toBe('declined');
    expect(await sessionStage(db, 't4')).toBe('expired');
  });
});

describe('expire_stale_checkout_session — race safety: completion always wins', () => {
  let db: PGlite;
  beforeEach(async () => { db = await freshDb(); });

  it('does NOT decline a plan whose session already reached stage=completed, even past expiry', async () => {
    const planId = await seed(db, { token: 't5', planStatus: 'active', stage: 'completed', expiresAt: PAST });
    await db.query(`select expire_stale_checkout_session($1, false)`, ['t5']);
    expect(await planStatus(db, planId)).toBe('active');
    expect(await sessionStage(db, 't5')).toBe('completed');
  });

  it('does NOT decline a plan whose session already reached stage=completed, even with force=true', async () => {
    // The adversarial case named explicitly in the task: a session that
    // completed just before "Start next patient" is clicked must not be
    // incorrectly declined by the force path either.
    const planId = await seed(db, { token: 't6', planStatus: 'active', stage: 'completed', expiresAt: FUTURE });
    await db.query(`select expire_stale_checkout_session($1, true)`, ['t6']);
    expect(await planStatus(db, planId)).toBe('active');
    expect(await sessionStage(db, 't6')).toBe('completed');
  });

  it('does not touch the session stage either when the plan already left the decline-eligible statuses for some other reason', async () => {
    // Simulates the narrow window where activateFirstInstalment's own
    // plan-status flip has landed but the session's own stage='completed'
    // stamp (a separate, later statement in complete/page.tsx) has not
    // committed yet. Session stage is deliberately left untouched rather
    // than unilaterally marked 'expired', since the plan side is already
    // authoritative — see the migration's inline comment on this.
    const planId = await seed(db, { token: 't7', planStatus: 'active', stage: 'scanned', expiresAt: PAST });
    await db.query(`select expire_stale_checkout_session($1, false)`, ['t7']);
    expect(await planStatus(db, planId)).toBe('active');
    expect(await sessionStage(db, 't7')).toBe('scanned');
  });
});

describe('expire_stale_checkout_session — idempotency + missing token', () => {
  let db: PGlite;
  beforeEach(async () => { db = await freshDb(); });

  it('a second call on an already-expired session is a safe no-op', async () => {
    const planId = await seed(db, { token: 't8', planStatus: 'pending_acceptance', stage: 'created', expiresAt: PAST });
    await db.query(`select expire_stale_checkout_session($1, false)`, ['t8']);
    await db.query(`select expire_stale_checkout_session($1, false)`, ['t8']);
    expect(await planStatus(db, planId)).toBe('declined');
    expect(await sessionStage(db, 't8')).toBe('expired');
  });

  it('a nonexistent token is a silent no-op (no error)', async () => {
    await expect(db.query(`select expire_stale_checkout_session($1, false)`, ['does-not-exist']))
      .resolves.toBeTruthy();
  });
});
