// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Real RPC execution test (migration 0083) ───────────────────────────
//
// Source-text pins prove the SQL *says* the right thing; this proves the
// functions *do* the right thing. It loads the ACTUAL archive_card /
// set_default_card_flag bodies out of the migration file and runs them in an
// in-process Postgres (pglite, real plpgsql), then calls them DIRECTLY —
// bypassing the UI entirely — to prove the server refuses on its own.
//
// A minimal schema + an auth.uid() stub (reading a session GUC) stands in
// for Supabase; the function bodies under test are byte-for-byte the ones
// that ship.

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0083_card_archive_and_default_scope.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

/** Extract a full `CREATE OR REPLACE FUNCTION <name> … $$;` block verbatim. */
function fnSql(name: string): string {
  const start = MIG.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  if (start < 0) throw new Error(`function ${name} not found in migration`);
  const end = MIG.indexOf('$$;', start);
  return MIG.slice(start, end + 3);
}

const SCHEMA = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create table payment_methods (
    id          uuid primary key default gen_random_uuid(),
    patient_id  uuid not null,
    token       text not null,
    last_four   text,
    is_default  boolean not null default false,
    archived_at timestamptz,
    created_at  timestamptz not null default now()
  );
  create table plans (
    id                    uuid primary key default gen_random_uuid(),
    patient_id            uuid not null,
    status                text not null,
    peach_registration_id text
  );
`;

const U  = '11111111-1111-1111-1111-111111111111';
const C  = '00000000-0000-0000-0000-0000000000c1'; // default card, token tokC
const D  = '00000000-0000-0000-0000-0000000000d2'; // newer other card, token tokD

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(fnSql('set_default_card_flag'));
  await db.exec(fnSql('archive_card'));
  await db.exec(`select set_config('test.uid', '${U}', false);`);
  return db;
}

async function seedCard(db: PGlite, id: string, token: string, isDefault: boolean, createdAt: string) {
  await db.query(
    `insert into payment_methods (id, patient_id, token, last_four, is_default, created_at)
     values ($1, $2, $3, '4081', $4, $5)`,
    [id, U, token, isDefault, createdAt],
  );
}
async function seedPlan(db: PGlite, status: string, token: string) {
  await db.query(
    `insert into plans (patient_id, status, peach_registration_id) values ($1, $2, $3)`,
    [U, status, token],
  );
}
async function cardRow(db: PGlite, id: string) {
  const r = await db.query<{ is_default: boolean; archived_at: string | null; token: string }>(
    `select is_default, archived_at, token from payment_methods where id = $1`, [id],
  );
  return r.rows[0];
}

describe('archive_card — DB-enforced active-plan guard (direct RPC call)', () => {
  let db: PGlite;
  beforeEach(async () => { db = await freshDb(); });

  it('RAISES card_collecting_active_plan for a card backing an ACTIVE plan', async () => {
    await seedCard(db, C, 'tokC', true, '2026-01-01');
    await seedPlan(db, 'active', 'tokC');

    await expect(db.query(`select archive_card('${C}')`)).rejects.toThrow(/card_collecting_active_plan/);
    // And it did NOT archive — the card is untouched.
    expect((await cardRow(db, C)).archived_at).toBeNull();
  });

  it('RAISES for a pending_first_payment plan too', async () => {
    await seedCard(db, C, 'tokC', true, '2026-01-01');
    await seedPlan(db, 'pending_first_payment', 'tokC');
    await expect(db.query(`select archive_card('${C}')`)).rejects.toThrow(/card_collecting_active_plan/);
  });

  it('a COMPLETED plan does not block — archives, retaining the token', async () => {
    await seedCard(db, C, 'tokC', true, '2026-01-01');
    await seedPlan(db, 'completed', 'tokC');

    await db.query(`select archive_card('${C}')`);
    const row = await cardRow(db, C);
    expect(row.archived_at).not.toBeNull(); // soft-deleted
    expect(row.token).toBe('tokC');         // token retained for reconciliation
    expect(row.is_default).toBe(false);     // default flag cleared
  });

  it('archiving the default promotes the newest OTHER active card', async () => {
    await seedCard(db, C, 'tokC', true,  '2026-01-01');
    await seedCard(db, D, 'tokD', false, '2026-06-01'); // newer
    // no active plans

    const r = await db.query<{ archive_card: { promoted_default_id: string; promoted_last_four: string } }>(
      `select archive_card('${C}') as archive_card`,
    );
    expect(r.rows[0].archive_card.promoted_default_id).toBe(D);
    expect((await cardRow(db, C)).archived_at).not.toBeNull();
    expect((await cardRow(db, D)).is_default).toBe(true);
  });

  it('is idempotent on an already-archived card', async () => {
    await seedCard(db, C, 'tokC', false, '2026-01-01');
    await db.query(`select archive_card('${C}')`);
    await expect(db.query(`select archive_card('${C}')`)).resolves.toBeTruthy(); // no throw
  });

  it('RAISES not_authenticated when there is no session uid', async () => {
    await seedCard(db, C, 'tokC', true, '2026-01-01');
    await db.exec(`select set_config('test.uid', '', false);`);
    await expect(db.query(`select archive_card('${C}')`)).rejects.toThrow(/not_authenticated/);
  });
});

describe('set_default_card_flag — flips the flag, repoints NO plan (RULE 1)', () => {
  let db: PGlite;
  beforeEach(async () => { db = await freshDb(); });

  it('flips is_default without touching any plan\'s collecting token', async () => {
    await seedCard(db, C, 'tokC', true,  '2026-01-01');
    await seedCard(db, D, 'tokD', false, '2026-06-01');
    await seedPlan(db, 'active', 'tokC'); // an existing plan collecting from C

    await db.query(`select set_default_card_flag('${D}')`);

    expect((await cardRow(db, C)).is_default).toBe(false);
    expect((await cardRow(db, D)).is_default).toBe(true);
    // The crux of RULE 1: the existing plan still collects from the OLD card.
    const plan = await db.query<{ peach_registration_id: string }>(
      `select peach_registration_id from plans where patient_id = '${U}'`,
    );
    expect(plan.rows[0].peach_registration_id).toBe('tokC');
  });
});
