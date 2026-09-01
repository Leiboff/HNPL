// @vitest-environment node
//
// ─── The admin actions that move money leave a record (A-12) ───────────────
//
// 0048 built admin_audit_log and then almost nothing wrote to it. 0131 adds
// the trigger half: every change that IS the event — banking, role,
// settlement — records itself regardless of which code path drove the write.
//
// This suite runs against real Postgres because every claim in it is a claim
// about triggers, RLS and a CHECK constraint, none of which a stub can hold.
// It exercises the migration verbatim over a pre-0131 schema, so what passes
// is the rewrite rather than a description of it.
//
// TWO SEATS, and the difference between them is the point:
//
//   authenticated  an admin's browser session. auth.uid() is set, so the
//                  trigger names them.
//   service_role   the server actions that need the 0054 column locks
//                  bypassed. auth.uid() is NULL, so the trigger records the
//                  EVENT with no actor — which is the honest answer and the
//                  reason the call-site helper exists alongside it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0131_admin_audit_coverage.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const ADMIN    = '0000ad00-0000-0000-0000-00000000ad00';
const OWNER    = '0000010e-0000-0000-0000-00000000010e';
const STAFFER  = '0000c000-0000-0000-0000-00000000c000';
const GROUP    = '99990000-0000-0000-0000-000000009999';
const PRACTICE = '88880000-0000-0000-0000-000000008888';
const PAYOUT   = '77770000-0000-0000-0000-000000007777';
const BATCH    = '66660000-0000-0000-0000-000000006666';

/**
 * The pre-0131 world: 0048's table (actor_id NOT NULL, the two-value CHECK),
 * 0054's trigger with its owner_id placeholder, and the four tables the new
 * triggers attach to. Everything 0131 changes is present here in its old
 * form, so a passing assertion is evidence the migration did it.
 */
const SCHEMA = `
  create role anon          nologin;
  create role authenticated nologin;
  create role service_role  nologin bypassrls;

  create table _ctx (uid uuid);
  insert into _ctx values (null);
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select uid from _ctx limit 1 $$;

  create table profiles (
    id uuid primary key,
    role text,
    first_name text
  );

  create table practice_groups (
    id uuid primary key,
    name text,
    bank_name text, bank_account_number text, branch_code text,
    account_holder text, account_type text
  );

  create table practices (
    id uuid primary key,
    owner_id uuid references profiles(id),
    group_id uuid references practice_groups(id),
    name text,
    status text,
    fee_percent numeric(5,2),
    bank_name text, bank_account_number text, branch_code text,
    account_holder text, account_type text
  );

  create table payout_batches (
    id uuid primary key,
    practice_id uuid references practices(id),
    total_net numeric(12,2),
    status text not null default 'pending',
    paid_at timestamptz
  );

  create table payouts (
    id uuid primary key,
    practice_id uuid references practices(id),
    batch_id uuid references payout_batches(id),
    net_amount numeric(10,2),
    status text default 'pending',
    paid_at timestamptz
  );

  -- 0048, verbatim in the parts that matter.
  create table admin_audit_log (
    id          uuid primary key default gen_random_uuid(),
    actor_id    uuid not null references profiles(id) on delete restrict,
    entity_type text not null
      constraint admin_audit_log_entity_type_check
      check (entity_type in ('practice', 'customer')),
    entity_id   uuid not null,
    action      text not null,
    payload     jsonb not null default '{}'::jsonb,
    created_at  timestamptz not null default now()
  );

  create or replace function is_platform_admin() returns boolean
    language sql stable as $$
      select coalesce((select role from profiles where id = auth.uid()) = 'admin', false)
    $$;

  alter table admin_audit_log enable row level security;
  create policy "admins_select_admin_audit_log" on admin_audit_log
    for select using (is_platform_admin());
  create policy "admins_insert_admin_audit_log" on admin_audit_log
    for insert with check (is_platform_admin() and actor_id = auth.uid());

  -- 0054's trigger, WITH the placeholder this migration removes. Kept in its
  -- broken form deliberately: the test that proves the placeholder is gone is
  -- only meaningful if the placeholder was there to begin with.
  create or replace function log_practice_protected_changes()
  returns trigger language plpgsql security definer set search_path = public as $fn$
  declare v_actor uuid;
  begin
    v_actor := coalesce(auth.uid(), NEW.owner_id, OLD.owner_id);
    if v_actor is null then return NEW; end if;
    if NEW.fee_percent is distinct from OLD.fee_percent then
      insert into admin_audit_log (actor_id, entity_type, entity_id, action, payload)
      values (v_actor, 'practice', NEW.id, 'fee_changed',
              jsonb_build_object('from', OLD.fee_percent, 'to', NEW.fee_percent));
    end if;
    if NEW.status is distinct from OLD.status then
      insert into admin_audit_log (actor_id, entity_type, entity_id, action, payload)
      values (v_actor, 'practice', NEW.id, 'status_changed',
              jsonb_build_object('from', OLD.status, 'to', NEW.status));
    end if;
    return NEW;
  end;
  $fn$;

  create trigger trg_log_practice_protected_changes
    after update on practices for each row
    execute function log_practice_protected_changes();

  grant usage  on schema auth, public to anon, authenticated, service_role;
  grant select on _ctx                to anon, authenticated, service_role;
  grant execute on function auth.uid(), is_platform_admin()
                                      to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public
                                      to anon, authenticated, service_role;
`;

const SEED = `
  insert into profiles (id, role, first_name) values
    ('${ADMIN}',  'admin',   'Ada'),
    ('${OWNER}',  'practice','Owen'),
    ('${STAFFER}', 'patient', 'Pat');

  insert into practice_groups (id, name, bank_name, bank_account_number, branch_code, account_holder, account_type)
    values ('${GROUP}', 'Brand', 'FNB', '62012345678', '250655', 'Brand Pty', 'current');

  insert into practices (id, owner_id, group_id, name, status, fee_percent,
                         bank_name, bank_account_number, branch_code, account_holder, account_type)
    values ('${PRACTICE}', '${OWNER}', '${GROUP}', 'Branch', 'approved', 6.00,
            'Absa', '4055500011', '632005', 'Branch Pty', 'current');

  insert into payout_batches (id, practice_id, total_net, status)
    values ('${BATCH}', '${PRACTICE}', 12500.00, 'pending');
  insert into payouts (id, practice_id, batch_id, net_amount, status)
    values ('${PAYOUT}', '${PRACTICE}', '${BATCH}', 12500.00, 'pending');
`;

let db: PGlite;

type LogRow = {
  actor_id:    string | null;
  entity_type: string;
  entity_id:   string;
  action:      string;
  payload:     Record<string, unknown>;
};

/** Run as a browser session belonging to `uid`. */
async function asUser(uid: string | null, sql: string) {
  await db.exec(uid ? `update _ctx set uid = '${uid}';` : 'update _ctx set uid = null;');
  await db.exec('set role authenticated;');
  try {
    return await db.query(sql);
  } finally {
    await db.exec('reset role;');
  }
}

/** Run the way a server action's service-role client does: no auth.uid(). */
async function asService(sql: string) {
  await db.exec('update _ctx set uid = null;');
  await db.exec('set role service_role;');
  try {
    return await db.query(sql);
  } finally {
    await db.exec('reset role;');
  }
}

/** Read the log as the owning superuser — the assertions are about content. */
async function log(where: string): Promise<LogRow[]> {
  const r = await db.query(
    `select actor_id, entity_type, entity_id, action, payload
       from admin_audit_log where ${where} order by created_at, action;`,
  );
  return r.rows as LogRow[];
}

const clearLog = () => db.exec('delete from admin_audit_log;');

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(MIG);   // verbatim
}, 60_000);

afterAll(async () => { await db?.close(); });

// ─── 1. The table can hold what it now records ────────────────────────────

describe('the log can describe the entities it now covers', () => {
  it.each([
    ['practice'], ['customer'], ['practice_group'], ['payout'], ['payout_batch'], ['payment'],
  ])('accepts entity_type=%s', async (t) => {
    await expect(db.exec(
      `insert into admin_audit_log (actor_id, entity_type, entity_id, action)
       values ('${ADMIN}', '${t}', gen_random_uuid(), 'probe');`,
    )).resolves.toBeDefined();
    await clearLog();
  });

  it('still refuses an entity type nobody defined', async () => {
    await expect(db.exec(
      `insert into admin_audit_log (actor_id, entity_type, entity_id, action)
       values ('${ADMIN}', 'whatever', gen_random_uuid(), 'probe');`,
    )).rejects.toThrow(/admin_audit_log_entity_type_check/);
  });

  it('accepts a NULL actor — an unattributed event is still an event', async () => {
    await expect(db.exec(
      `insert into admin_audit_log (actor_id, entity_type, entity_id, action)
       values (null, 'payout', gen_random_uuid(), 'probe');`,
    )).resolves.toBeDefined();
    await clearLog();
  });

  it('but a CLIENT still cannot insert one — RLS is unchanged', async () => {
    // actor_id = auth.uid() with a NULL actor_id evaluates to NULL, which is
    // not true, so the WITH CHECK refuses. Nullability widened what a trigger
    // may record; it did not widen what a browser may claim.
    await expect(asUser(ADMIN,
      `insert into admin_audit_log (actor_id, entity_type, entity_id, action)
       values (null, 'payout', gen_random_uuid(), 'forged');`,
    )).rejects.toThrow(/row-level security/i);
  });

  it('and a client still cannot attribute a row to someone else', async () => {
    await expect(asUser(ADMIN,
      `insert into admin_audit_log (actor_id, entity_type, entity_id, action)
       values ('${OWNER}', 'practice', '${PRACTICE}', 'forged');`,
    )).rejects.toThrow(/row-level security/i);
  });

  it('a non-admin cannot write to the log at all', async () => {
    await expect(asUser(STAFFER,
      `insert into admin_audit_log (actor_id, entity_type, entity_id, action)
       values ('${STAFFER}', 'customer', '${STAFFER}', 'forged');`,
    )).rejects.toThrow(/row-level security/i);
  });

  it('a non-admin cannot read it either', async () => {
    await db.exec(
      `insert into admin_audit_log (actor_id, entity_type, entity_id, action)
       values ('${ADMIN}', 'practice', '${PRACTICE}', 'probe');`,
    );
    const r = await asUser(STAFFER, 'select * from admin_audit_log;');
    expect(r.rows).toHaveLength(0);
    await clearLog();
  });
});

// ─── 2. Banking — where the money goes ────────────────────────────────────

describe('a practice banking change records itself', () => {
  it('fires on the account number, and names the admin who did it', async () => {
    await clearLog();
    await asUser(ADMIN,
      `update practices set bank_account_number = '9999900001' where id = '${PRACTICE}';`);

    const rows = await log(`action = 'banking_changed'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(ADMIN);
    expect(rows[0].entity_type).toBe('practice');
    expect(rows[0].entity_id).toBe(PRACTICE);
  });

  it('records the last four digits, and NOT the account number', async () => {
    const rows = await log(`action = 'banking_changed'`);
    const p = rows[0].payload as { from: Record<string, unknown>; to: Record<string, unknown> };
    expect(p.from.account_last4).toBe('0011');
    expect(p.to.account_last4).toBe('0001');
    // The whole point of the redaction: an append-only table readable by
    // every admin must not become a permanent store of bank accounts.
    expect(JSON.stringify(rows[0].payload)).not.toContain('4055500011');
    expect(JSON.stringify(rows[0].payload)).not.toContain('9999900001');
  });

  it('records a digest, so "changed and changed back" is provable', async () => {
    // The scenario A-12 is about: redirect the Friday EFT, then restore the
    // original so the row looks untouched. Two rows, and the second's `to`
    // digest equals the first's `from` digest — which is exactly the
    // signature of a round trip, and is unanswerable from last-4 alone
    // (many accounts share four digits).
    await asUser(ADMIN,
      `update practices set bank_account_number = '4055500011' where id = '${PRACTICE}';`);

    const rows = await log(`action = 'banking_changed'`);
    expect(rows).toHaveLength(2);
    const first  = rows[0].payload as { from: { account_sha256: string } };
    const second = rows[1].payload as { to:   { account_sha256: string } };
    expect(second.to.account_sha256).toBe(first.from.account_sha256);
    expect(first.from.account_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fires on the branch code and the holder too, not only the number', async () => {
    // A payment can be redirected by changing the branch code alone.
    await clearLog();
    await asUser(ADMIN, `update practices set branch_code = '470010' where id = '${PRACTICE}';`);
    await asUser(ADMIN, `update practices set account_holder = 'Someone Else' where id = '${PRACTICE}';`);
    expect(await log(`action = 'banking_changed'`)).toHaveLength(2);
  });

  it('writes ONE row for a whole-tuple edit, not five', async () => {
    await clearLog();
    await asUser(ADMIN, `
      update practices set
        bank_name = 'Capitec', bank_account_number = '1234567890',
        branch_code = '470010', account_holder = 'New Holder',
        account_type = 'savings'
      where id = '${PRACTICE}';`);
    expect(await log(`action = 'banking_changed'`)).toHaveLength(1);
  });

  it('stays silent when nothing banking-related moved', async () => {
    await clearLog();
    await asUser(ADMIN, `update practices set name = 'Renamed' where id = '${PRACTICE}';`);
    expect(await log('true')).toHaveLength(0);
  });

  it('records a service-role change with NO actor rather than the wrong one', async () => {
    // 0054's placeholder attributed an unattributable write to the practice
    // OWNER. An audit trail that names an innocent person is worse than one
    // that says "unknown": the first is evidence, the second is a prompt to
    // go and correlate the request logs.
    await clearLog();
    await asService(`update practices set bank_account_number = '5555500022' where id = '${PRACTICE}';`);

    const rows = await log(`action = 'banking_changed'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBeNull();
    expect(rows[0].actor_id).not.toBe(OWNER);
  });
});

describe('the group-level account — the one every branch can fall back to', () => {
  it('records a change to the brand banking', async () => {
    await clearLog();
    await asUser(ADMIN,
      `update practice_groups set bank_account_number = '1112223334' where id = '${GROUP}';`);

    const rows = await log(`entity_type = 'practice_group'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('banking_changed');
    expect(rows[0].entity_id).toBe(GROUP);
    expect(rows[0].actor_id).toBe(ADMIN);
    expect(JSON.stringify(rows[0].payload)).not.toContain('1112223334');
  });

  it('stays silent on a rename', async () => {
    await clearLog();
    await asUser(ADMIN, `update practice_groups set name = 'Rebrand' where id = '${GROUP}';`);
    expect(await log('true')).toHaveLength(0);
  });
});

// ─── 3. Roles ─────────────────────────────────────────────────────────────

describe('a role change records itself', () => {
  it('records patient → sales against that person\'s own timeline', async () => {
    await clearLog();
    // The real grantSalesRole goes through the service-role client (the 0054
    // column lock demands it), so this is the attribution the trigger can
    // actually offer on that path.
    await asService(`update profiles set role = 'sales' where id = '${STAFFER}';`);

    const rows = await log(`action = 'role_changed'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe('customer');   // profiles.id — see the migration header
    expect(rows[0].entity_id).toBe(STAFFER);
    expect(rows[0].payload).toEqual({ from: 'patient', to: 'sales' });
  });

  it('records the revoke as well as the grant', async () => {
    await clearLog();
    await asService(`update profiles set role = 'patient' where id = '${STAFFER}';`);
    const rows = await log(`action = 'role_changed'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ from: 'sales', to: 'patient' });
  });

  it('records a jump straight to admin — the path nobody has written yet', async () => {
    // The reason the trigger half exists. No current action grants admin;
    // if one ever does, or somebody does it in psql, it is recorded anyway.
    await clearLog();
    await asService(`update profiles set role = 'admin' where id = '${STAFFER}';`);
    const rows = await log(`action = 'role_changed'`);
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { to: string }).to).toBe('admin');
    await asService(`update profiles set role = 'patient' where id = '${STAFFER}';`);
  });

  it('stays silent on any other profile edit', async () => {
    await clearLog();
    await asService(`update profiles set first_name = 'Patricia' where id = '${STAFFER}';`);
    expect(await log('true')).toHaveLength(0);
  });
});

// ─── 4. Settlement — the assertion that money left the bank ───────────────

describe('marking a payout paid records itself', () => {
  it('records the batch flip with the amount an auditor would reconcile', async () => {
    await clearLog();
    await asUser(ADMIN,
      `update payout_batches set status = 'paid', paid_at = now() where id = '${BATCH}';`);

    const rows = await log(`entity_type = 'payout_batch'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('marked_paid');
    expect(rows[0].actor_id).toBe(ADMIN);
    expect(rows[0].entity_id).toBe(BATCH);
    const p = rows[0].payload as { from: string; amount: string; practice_id: string };
    expect(p.from).toBe('pending');
    expect(Number(p.amount)).toBe(12500);
    expect(p.practice_id).toBe(PRACTICE);
  });

  it('records the member payout flip separately, with its own amount', async () => {
    await clearLog();
    await asUser(ADMIN,
      `update payouts set status = 'paid', paid_at = now() where id = '${PAYOUT}';`);

    const rows = await log(`entity_type = 'payout'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('marked_paid');
    expect(Number((rows[0].payload as { amount: string }).amount)).toBe(12500);
  });

  it('does NOT fire again on a re-flip of an already-paid row', async () => {
    // markBatchPaid's writes are conditional on 'pending', but a future path
    // that is not must still not manufacture a second settlement record.
    await clearLog();
    await asUser(ADMIN, `update payouts set paid_at = now() where id = '${PAYOUT}';`);
    expect(await log('true')).toHaveLength(0);
  });

  it('does NOT fire on batching, which is not a settlement', async () => {
    // The weekly cron sets batch_id on a pending payout. That is bookkeeping,
    // not money leaving, and logging it would bury the rows that matter.
    await clearLog();
    await db.exec(`
      insert into payouts (id, practice_id, net_amount, status)
      values ('55550000-0000-0000-0000-000000005555', '${PRACTICE}', 700.00, 'pending');`);
    await asService(`
      update payouts set batch_id = '${BATCH}'
       where id = '55550000-0000-0000-0000-000000005555';`);
    expect(await log('true')).toHaveLength(0);
  });

  it('records a settlement with no session as unattributed, not as nobody', async () => {
    await clearLog();
    await asService(`
      update payouts set status = 'paid', paid_at = now()
       where id = '55550000-0000-0000-0000-000000005555';`);
    const rows = await log(`entity_type = 'payout'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBeNull();
  });
});

// ─── 5. The 0054 behaviour that had to keep working ───────────────────────

describe('what 0054 already recorded still gets recorded', () => {
  it('a fee change still logs from → to', async () => {
    await clearLog();
    await asUser(ADMIN, `update practices set fee_percent = 5.50 where id = '${PRACTICE}';`);
    const rows = await log(`action = 'fee_changed'`);
    expect(rows).toHaveLength(1);
    expect(Number((rows[0].payload as { from: string }).from)).toBe(6);
    expect(Number((rows[0].payload as { to: string }).to)).toBe(5.5);
  });

  it('a status change still logs from → to', async () => {
    await clearLog();
    await asUser(ADMIN, `update practices set status = 'suspended' where id = '${PRACTICE}';`);
    const rows = await log(`action = 'status_changed'`);
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { to: string }).to).toBe('suspended');
  });

  it('a single UPDATE touching fee, status and banking writes all three rows', async () => {
    await clearLog();
    await asUser(ADMIN, `
      update practices set fee_percent = 7.00, status = 'approved',
                           bank_account_number = '8888800033'
       where id = '${PRACTICE}';`);
    const actions = (await log('true')).map((r) => r.action).sort();
    expect(actions).toEqual(['banking_changed', 'fee_changed', 'status_changed']);
  });
});
