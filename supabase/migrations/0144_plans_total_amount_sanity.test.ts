// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0144_plans_total_amount_sanity.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const ADMIN = '00000000-0000-0000-0000-00000000ad00';
const SCHEMA = `
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create table profiles (id uuid primary key, role text not null);
  insert into profiles values ('${ADMIN}', 'admin');
  create function is_platform_admin() returns boolean language sql stable as
    $$ select true $$;
  create table plans (
    id uuid primary key default gen_random_uuid(),
    total_amount numeric(10,2) not null
  );
  grant insert, select on plans to authenticated;
  create table admin_audit_log (
    id uuid primary key default gen_random_uuid(),
    actor_id uuid,
    entity_type text not null,
    entity_id uuid not null,
    action text not null,
    payload jsonb not null default '{}'::jsonb
  );
  alter table admin_audit_log add constraint admin_audit_log_entity_type_check
    check (entity_type in ('practice','customer','practice_group','payout',
      'payout_batch','payment','auth_factor'));
`;

let db: PGlite | undefined;

async function createDatabase(): Promise<PGlite> {
  db = new PGlite();
  await db.exec(SCHEMA);
  return db;
}

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function insertAsPractice(database: PGlite, amount: string): Promise<void> {
  await database.exec('set role authenticated');
  try {
    await database.query('insert into plans (total_amount) values ($1::numeric)', [amount]);
  } finally {
    await database.exec('reset role');
  }
}

describe('0144 / S-05 — configurable plan total backstop', () => {
  it.each(['0', '-0.01', '30000.01', 'NaN'])(
    'rejects the absolute-boundary violation %s',
    async (amount) => {
      const database = await createDatabase();
      await database.exec(MIGRATION);
      await expect(insertAsPractice(database, amount)).rejects.toThrow(
        /plans_total_amount_sane|check constraint|configured maximum/i,
      );
    },
  );

  it.each(['0.01', '1', '29999.99', '30000'])(
    'accepts the absolute valid value %s',
    async (amount) => {
      const database = await createDatabase();
      await database.exec(MIGRATION);
      await expect(insertAsPractice(database, amount)).resolves.toBeUndefined();
    },
  );

  it('enforces a lower configured maximum on direct writes', async () => {
    const database = await createDatabase();
    await database.exec(MIGRATION);
    await database.query(
      'select set_max_bill_amount($1, $2)',
      ['12500.50', ADMIN],
    );

    await expect(insertAsPractice(database, '12500.51')).rejects.toThrow(
      /plans_total_amount_configured_max|configured maximum/i,
    );
    await expect(insertAsPractice(database, '12500.50')).resolves.toBeUndefined();
  });

  it('rejects invalid admin settings and audits a valid change', async () => {
    const database = await createDatabase();
    await database.exec(MIGRATION);

    await expect(database.query(
      'select set_max_bill_amount($1, $2)', ['30000.01', ADMIN],
    )).rejects.toThrow(/between 0.01 and 30000.00/i);

    await database.query('select set_max_bill_amount($1, $2)', ['25000', ADMIN]);
    const result = await database.query<{ max: string; action: string; actor_id: string }>(`
      select s.max_bill_amount::text as max, a.action, a.actor_id::text
      from platform_settings s
      join admin_audit_log a on a.entity_type = 'platform_setting'
      where s.singleton = true
    `);
    expect(result.rows).toEqual([{
      max: '25000.00', action: 'max_bill_amount_changed', actor_id: ADMIN,
    }]);
  });

  it('refuses deployment when a malformed historical row exists', async () => {
    const database = await createDatabase();
    await database.query('insert into plans (total_amount) values (30000.01)');
    await expect(database.exec(MIGRATION)).rejects.toThrow(
      /plans_total_amount_sane|check constraint/i,
    );
  });
});
