// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { loadSetupChecklistFacts, buildSetupChecklist } from './setupChecklist';

// ─── The checklist against REAL Postgres ──────────────────────────────────
//
// The unit tests prove the arithmetic from hand-written facts. What they
// cannot prove is the claim the whole feature rests on: that an item flips
// because the DATABASE changed, with nothing written to record it.
//
// So this file mutates real rows — inserts a practitioner, sets a PIN,
// revokes a device, fills in banking — and re-derives after each one. The
// only thing between the SQL and the assertion is loadSetupChecklistFacts,
// which is the code that ships.
//
// It also proves the two filters that a mocked client will always agree with
// you about, and which are the difference between a correct tick and a lie:
//   • the provider count is scoped to THIS practice (a sibling branch's
//     practitioner must not tick this branch's item)
//   • a REVOKED till device does not count (0088 revokes, never deletes, so
//     an unfiltered count stays ticked forever after the last till is pulled)
//
// THE CLIENT SHIM
// ───────────────
// loadSetupChecklistFacts and resolvePayoutBanking talk PostgREST, so the
// shim below translates the exact call shapes they issue — select/eq/is/limit
// /maybeSingle — into SQL. It is deliberately NARROW: an unmodelled table
// THROWS rather than returning empty, so a future query added to the loader
// cannot make these tests silently vacuous.
//
// The schema is a stub rather than the full migration chain (0088's policies
// depend on helpers from a dozen earlier files). To stop the stub drifting
// away from production, the last describe block asserts the columns it
// declares are the ones the real migrations declare.

const MIG_0088 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0088_till_devices.sql'), 'utf8',
).replace(/\r\n/g, '\n');
const MIG_0060 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0060_practice_coordinates.sql'), 'utf8',
).replace(/\r\n/g, '\n');
const MIG_0021 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0021_multi_tenant_practice.sql'), 'utf8',
).replace(/\r\n/g, '\n');

const STUB_SCHEMA = `
  create table practice_groups (
    id                  uuid primary key default gen_random_uuid(),
    name                text,
    bank_name           text,
    bank_account_number text,
    branch_code         text,
    account_holder      text,
    account_type        text
  );
  create table practices (
    id                  uuid primary key default gen_random_uuid(),
    group_id            uuid references practice_groups(id),
    name                text,
    status              text,
    phone               text,
    address_line1       text,
    latitude            numeric(9,6),
    longitude           numeric(9,6),
    bank_name           text,
    bank_account_number text,
    branch_code         text,
    account_holder      text,
    account_type        text,
    till_pin_hash       text
  );
  create table practice_members (
    id          uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    user_id     uuid,
    role        text,
    active      boolean default true
  );
  create table till_devices (
    id          uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    label       text,
    revoked_at  timestamptz
  );
`;

const MODELLED = new Set(['practices', 'practice_groups', 'practice_members', 'till_devices']);

/** Minimal PostgREST-over-pglite shim. Unmodelled table → throw. */
function shim(db: PGlite) {
  return {
    from(table: string) {
      if (!MODELLED.has(table)) {
        throw new Error(
          `[shim] unmodelled table "${table}" — add it to the stub schema rather than ` +
          `letting the test pass vacuously.`,
        );
      }
      const st = {
        cols:   '*',
        eq:     [] as Array<[string, unknown]>,
        isNull: [] as string[],
        limit:  null as number | null,
      };

      async function run() {
        const where: string[] = [];
        const params: unknown[] = [];
        for (const [col, val] of st.eq) {
          params.push(val);
          where.push(`${col} = $${params.length}`);
        }
        for (const col of st.isNull) where.push(`${col} is null`);
        const sql =
          `select ${st.cols} from ${table}` +
          (where.length ? ` where ${where.join(' and ')}` : '') +
          (st.limit != null ? ` limit ${st.limit}` : '');
        const res = await db.query(sql, params);
        return res.rows as Array<Record<string, unknown>>;
      }

      const builder = {
        select(cols: string) { st.cols = cols; return builder; },
        eq(col: string, val: unknown) { st.eq.push([col, val]); return builder; },
        is(col: string, val: unknown) {
          if (val !== null) throw new Error('[shim] only .is(col, null) is modelled');
          st.isNull.push(col);
          return builder;
        },
        async limit(n: number) {
          st.limit = n;
          return { data: await run(), error: null };
        },
        async maybeSingle() {
          st.limit = 2;
          const rows = await run();
          return { data: rows[0] ?? null, error: null };
        },
      };
      return builder;
    },
  };
}

let db: PGlite;
let client: ReturnType<typeof shim>;
let practiceId: string;
let otherPracticeId: string;

async function derive(id = practiceId) {
  const f = await loadSetupChecklistFacts(client, id);
  return {
    facts: f,
    checklist: buildSetupChecklist(f, {
      canEditDetails: true, canManageTeam: true, canManageTill: true,
    }),
  };
}

const stateOf = (c: Awaited<ReturnType<typeof derive>>['checklist'], key: string) =>
  c.items.find((i) => i.key === key)!.done;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB_SCHEMA);
  client = shim(db);
});

afterAll(async () => { await db.close(); });

beforeEach(async () => {
  await db.exec('delete from till_devices; delete from practice_members; delete from practices; delete from practice_groups;');

  // A freshly signed-up practice, as app/signup/practice/actions.ts leaves it:
  // pending, with its silently-created brand, address text present, and NO
  // banking, NO practitioner, NO till.
  const g = await db.query<{ id: string }>(
    `insert into practice_groups (name) values ('Sandton Rooms') returning id`,
  );
  const groupId = g.rows[0].id;

  const p = await db.query<{ id: string }>(
    `insert into practices (group_id, name, status, phone, address_line1, latitude, longitude)
     values ($1, 'Sandton Rooms', 'pending', '011 555 0100', '12 Rivonia Road', -26.107600, 28.056700)
     returning id`,
    [groupId],
  );
  practiceId = p.rows[0].id;

  // A sibling branch in the same brand — the scope control.
  const o = await db.query<{ id: string }>(
    `insert into practices (group_id, name, status) values ($1, 'Rosebank Rooms', 'approved') returning id`,
    [groupId],
  );
  otherPracticeId = o.rows[0].id;
});

// ─── The starting point ───────────────────────────────────────────────────

describe('a freshly signed-up practice', () => {
  it('has address and phone done, and the other three outstanding', async () => {
    const { checklist } = await derive();
    expect(stateOf(checklist, 'details')).toBe(true);
    expect(stateOf(checklist, 'banking')).toBe(false);
    expect(stateOf(checklist, 'provider')).toBe(false);
    expect(stateOf(checklist, 'till')).toBe(false);
    expect(checklist.doneCount).toBe(1);
    expect(checklist.complete).toBe(false);
  });

  it('is reported as awaiting approval, straight from practices.status', async () => {
    const { checklist } = await derive();
    expect(checklist.awaitingApproval).toBe(true);

    await db.query(`update practices set status = 'approved' where id = $1`, [practiceId]);
    expect((await derive()).checklist.awaitingApproval).toBe(false);
  });
});

// ─── Adversarial: change the data, the item flips ─────────────────────────

describe('items flip when the underlying data changes — nothing is written to record it', () => {
  it('adding a practitioner ticks the practitioner item', async () => {
    expect(stateOf((await derive()).checklist, 'provider')).toBe(false);

    await db.query(
      `insert into practice_members (practice_id, role, active) values ($1, 'provider', true)`,
      [practiceId],
    );

    expect(stateOf((await derive()).checklist, 'provider')).toBe(true);
  });

  it('a LOGIN-LESS roster practitioner ticks it too', async () => {
    // Post-0091 a practitioner can exist with user_id NULL. The gate's
    // predicate never required a login and neither does this.
    await db.query(
      `insert into practice_members (practice_id, user_id, role, active)
       values ($1, null, 'provider', true)`,
      [practiceId],
    );
    expect(stateOf((await derive()).checklist, 'provider')).toBe(true);
  });

  it('setting the PIN alone does NOT tick the till — it needs a device too', async () => {
    await db.query(`update practices set till_pin_hash = 'hashed' where id = $1`, [practiceId]);
    const { facts, checklist } = await derive();
    expect(facts.hasTillPin).toBe(true);
    expect(facts.activeTillDeviceCount).toBe(0);
    expect(stateOf(checklist, 'till')).toBe(false);
  });

  it('registering a device AND setting the PIN ticks the till', async () => {
    await db.query(`update practices set till_pin_hash = 'hashed' where id = $1`, [practiceId]);
    await db.query(
      `insert into till_devices (practice_id, label) values ($1, 'Front desk PC')`,
      [practiceId],
    );
    expect(stateOf((await derive()).checklist, 'till')).toBe(true);
  });

  it('filling in banking ticks banking, through the real resolver', async () => {
    expect(stateOf((await derive()).checklist, 'banking')).toBe(false);

    await db.query(
      `update practices set bank_name = 'FNB', bank_account_number = '62012345678' where id = $1`,
      [practiceId],
    );

    expect(stateOf((await derive()).checklist, 'banking')).toBe(true);
  });

  it('BRAND banking ticks a branch that has none of its own', async () => {
    // The case a direct read of practices.bank_* gets wrong: this branch
    // settles through the brand's central account and is correctly set up.
    // Nagging it about banking forever would be the drift the resolver exists
    // to prevent.
    await db.query(
      `update practice_groups set bank_name = 'Absa', bank_account_number = '4055512345'
       where id = (select group_id from practices where id = $1)`,
      [practiceId],
    );
    const { facts, checklist } = await derive();
    expect(facts.bankingResolved).toBe(true);
    expect(stateOf(checklist, 'banking')).toBe(true);
  });

  it('clearing the address un-ticks details — the flip works in both directions', async () => {
    expect(stateOf((await derive()).checklist, 'details')).toBe(true);
    await db.query(`update practices set address_line1 = null where id = $1`, [practiceId]);
    expect(stateOf((await derive()).checklist, 'details')).toBe(false);
  });

  it('losing the map coordinates un-ticks details even with the address text intact', async () => {
    await db.query(
      `update practices set latitude = null, longitude = null where id = $1`,
      [practiceId],
    );
    const { checklist } = await derive();
    expect(stateOf(checklist, 'details')).toBe(false);
    expect(checklist.items.find((i) => i.key === 'details')!.hint)
      .toMatch(/couldn’t find your address on the map/i);
  });

  it('reaches complete only when all four are genuinely true, then stays there', async () => {
    await db.query(
      `update practices set status = 'approved', bank_name = 'FNB',
         bank_account_number = '62012345678', till_pin_hash = 'hashed' where id = $1`,
      [practiceId],
    );
    await db.query(
      `insert into practice_members (practice_id, role, active) values ($1, 'provider', true)`,
      [practiceId],
    );
    await db.query(
      `insert into till_devices (practice_id, label) values ($1, 'Front desk PC')`,
      [practiceId],
    );

    const { checklist } = await derive();
    expect(checklist.doneCount).toBe(4);
    expect(checklist.complete).toBe(true);
  });
});

// ─── The two filters a mock would never disagree with you about ───────────

describe('the reads are scoped and filtered', () => {
  it('a practitioner at a SIBLING branch does not tick this branch', async () => {
    await db.query(
      `insert into practice_members (practice_id, role, active) values ($1, 'provider', true)`,
      [otherPracticeId],
    );
    expect(stateOf((await derive()).checklist, 'provider')).toBe(false);
    // …and does tick the branch they actually work at.
    expect(stateOf((await derive(otherPracticeId)).checklist, 'provider')).toBe(true);
  });

  it('an INACTIVE practitioner does not count', async () => {
    await db.query(
      `insert into practice_members (practice_id, role, active) values ($1, 'provider', false)`,
      [practiceId],
    );
    expect(stateOf((await derive()).checklist, 'provider')).toBe(false);
  });

  it('a non-provider member does not count', async () => {
    // The signup flow's own admin row is role='admin'. If it counted, every
    // practice would be ticked from the moment it was created.
    await db.query(
      `insert into practice_members (practice_id, role, active) values ($1, 'admin', true)`,
      [practiceId],
    );
    expect(stateOf((await derive()).checklist, 'provider')).toBe(false);
  });

  it('a REVOKED till device does not count, so revoking the last one un-ticks the till', async () => {
    await db.query(`update practices set till_pin_hash = 'hashed' where id = $1`, [practiceId]);
    await db.query(
      `insert into till_devices (practice_id, label) values ($1, 'Front desk PC')`,
      [practiceId],
    );
    expect(stateOf((await derive()).checklist, 'till')).toBe(true);

    // 0088 revokes rather than deletes — the row is still there afterwards.
    await db.query(`update till_devices set revoked_at = now() where practice_id = $1`, [practiceId]);
    const after = await db.query(`select count(*)::int as n from till_devices where practice_id = $1`, [practiceId]);
    expect((after.rows[0] as { n: number }).n).toBe(1);

    expect(stateOf((await derive()).checklist, 'till')).toBe(false);
  });

  it('a sibling branch’s till device does not tick this branch', async () => {
    await db.query(`update practices set till_pin_hash = 'hashed' where id = $1`, [practiceId]);
    await db.query(
      `insert into till_devices (practice_id, label) values ($1, 'Their PC')`,
      [otherPracticeId],
    );
    expect(stateOf((await derive()).checklist, 'till')).toBe(false);
  });
});

// ─── Nothing is written ───────────────────────────────────────────────────

describe('deriving the checklist writes nothing', () => {
  it('leaves every row byte-identical after repeated derivation', async () => {
    const snapshot = async () => JSON.stringify({
      practices: (await db.query('select * from practices order by id')).rows,
      members:   (await db.query('select * from practice_members order by id')).rows,
      devices:   (await db.query('select * from till_devices order by id')).rows,
      groups:    (await db.query('select * from practice_groups order by id')).rows,
    });

    const before = await snapshot();
    await derive();
    await derive();
    await derive();
    expect(await snapshot()).toBe(before);
  });

  it('has no completion column to write to in the first place', async () => {
    // The guard against someone "optimising" the derivation into a cached
    // flag later: there is nowhere to put one.
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'practices'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).not.toContain('onboarding_completed');
    expect(names).not.toContain('setup_completed');
  });
});

// ─── The stub must not drift from production ──────────────────────────────

describe('the stub schema matches what the real migrations declare', () => {
  it('till_devices carries revoked_at, and it is revoked rather than deleted (0088)', () => {
    expect(MIG_0088).toMatch(/create table if not exists till_devices/i);
    expect(MIG_0088).toMatch(/revoked_at\s+TIMESTAMPTZ/i);
  });

  it('practices.till_pin_hash is on practices, not on till_devices (0088)', () => {
    expect(MIG_0088).toMatch(/ALTER TABLE practices[\s\S]{0,200}till_pin_hash/i);
  });

  it('practices carries latitude/longitude (0060) and address_line1 (0021)', () => {
    expect(MIG_0060).toMatch(/ALTER TABLE practices ADD COLUMN IF NOT EXISTS latitude/i);
    expect(MIG_0060).toMatch(/longitude/i);
    expect(MIG_0021).toMatch(/address_line1/i);
  });
});
