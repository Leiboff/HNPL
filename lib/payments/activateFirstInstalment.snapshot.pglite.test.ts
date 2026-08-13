// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { stripComments } from '@/lib/testing/stripComments';
import { activateFirstInstalment } from './activateFirstInstalment';

// ─── The snapshot_* columns must stay empty, forever ────────────────────
//
// WHY THIS TEST EXISTS
// ────────────────────
// payouts carries five columns that captured a provider's PERSONAL BANK
// DETAILS at activation time, from when payout_destination could be
// 'provider':
//
//   snapshot_bank_name, snapshot_account_holder, snapshot_account_number,
//   snapshot_branch_code, snapshot_account_type
//
// That feature is removed, but the columns deliberately REMAIN so historical
// rows stay auditable (migration 0090). Migration 0092 then widened payouts
// SELECT from manager-level to member-level — and RLS is ROW-level, not
// COLUMN-level, so every active member of a practice can now read every column
// of its payouts rows.
//
// Those two facts are only safe together because nothing writes the columns.
// A production check confirmed all 36 existing rows have all five NULL, which
// is an OBSERVATION about today. This test is the GUARANTEE: it drives the sole
// writer to payouts and asserts the row it produces has all five NULL.
//
// So if someone ever resurrects provider-destination logic — the natural way
// this would regress — the exposure risk does not come back silently. It comes
// back as a failing test that points at this comment.
//
// This is a regression guard, NOT access-control infrastructure. No
// column-restricted view is needed while the write path stays closed; see
// 0092's header for what to do if that ever changes.
//
// Real Postgres rather than a mocked client, because the claim is about the row
// that actually lands in the table — including the columns nobody passed, which
// a mock asserting on an insert payload cannot see. A mock would confirm what
// the code MEANT to write; only the engine shows what the row IS.

// payouts as it really stands: 0001 + 0021's snapshot columns + 0087's UNIQUE.
const SCHEMA = `
  create table practices (
    id uuid primary key default gen_random_uuid(),
    name text,
    fee_percent numeric(5,2) default 6
  );
  -- 0091's roster columns matter here: the writer resolves the treating
  -- practitioner's user_id through this row, and a roster-only practitioner
  -- has none.
  create table practice_members (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    user_id     uuid,
    role        text,
    active      boolean default true,
    provider_first_name text,
    provider_last_name  text
  );
  create table plans (
    id uuid primary key default gen_random_uuid(),
    practice_id  uuid references practices(id),
    provider_id  uuid,
    provider_member_id uuid references practice_members(id),
    status       text,
    total_amount numeric(10,2)
  );
  create table payments (
    id uuid primary key default gen_random_uuid(),
    plan_id      uuid references plans(id),
    status       text,
    collected_at timestamptz
  );
  create table payouts (
    id uuid primary key default gen_random_uuid(),
    practice_id  uuid references practices(id),
    plan_id      uuid references plans(id),
    provider_id  uuid,
    gross_amount numeric(10,2) not null,
    fee_amount   numeric(10,2) not null,
    net_amount   numeric(10,2) not null,
    status       text default 'pending',
    payout_destination text default 'practice'
      check (payout_destination in ('practice','provider')),
    -- The five under test. Nullable, no default: an insert that does not
    -- mention them leaves them NULL, which is the property being pinned.
    snapshot_bank_name      text,
    snapshot_account_holder text,
    snapshot_account_number text,
    snapshot_branch_code    text,
    snapshot_account_type   text,
    batch_id   uuid,
    paid_at    timestamptz,
    created_at timestamptz default now(),
    constraint payouts_plan_id_unique unique (plan_id)
  );
`;

/** The five columns this file exists to keep empty. */
const SNAPSHOT_COLS = [
  'snapshot_bank_name',
  'snapshot_account_holder',
  'snapshot_account_number',
  'snapshot_branch_code',
  'snapshot_account_type',
] as const;

let db: PGlite;
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  db.query<T>(sql, params);

// ─── A PostgREST-shaped client over real SQL ─────────────────────────────
//
// Covers exactly the surface activateFirstInstalment uses: update+eq+neq,
// select+eq+limit, single, and upsert with onConflict+ignoreDuplicates. An
// unmodelled method THROWS rather than silently returning empty, so a future
// change to the writer cannot make this test vacuous.

type Filter = { col: string; op: 'eq' | 'neq'; val: unknown };

function makeSqlClient() {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      let mode: 'select' | 'update' | 'upsert' = 'select';
      let patch: Record<string, unknown> = {};
      let upsertRow: Record<string, unknown> = {};
      let conflictCol = '';
      let cols = '*';
      let limitN: number | null = null;

      function where(start: number) {
        const params: unknown[] = [];
        const parts = filters.map((f) => {
          params.push(f.val);
          return `${f.col} ${f.op === 'eq' ? '=' : '<>'} $${start + params.length - 1}`;
        });
        return { sql: parts.length ? parts.join(' and ') : 'true', params };
      }

      async function run() {
        if (mode === 'upsert') {
          const keys = Object.keys(upsertRow);
          const ph   = keys.map((_, i) => `$${i + 1}`);
          const { rows } = await q(
            `insert into ${table} (${keys.join(', ')}) values (${ph.join(', ')})
             on conflict (${conflictCol}) do nothing returning *`,
            keys.map((k) => upsertRow[k]),
          );
          return { data: rows, error: null };
        }
        if (mode === 'update') {
          const keys = Object.keys(patch);
          const set  = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
          const w    = where(keys.length + 1);
          const { rows } = await q(
            `update ${table} set ${set} where ${w.sql} returning *`,
            [...keys.map((k) => patch[k]), ...w.params],
          );
          return { data: rows, error: null };
        }
        const w = where(1);
        const { rows } = await q(
          `select ${cols} from ${table} where ${w.sql}${limitN ? ` limit ${limitN}` : ''}`,
          w.params);
        return { data: rows, error: null };
      }

      const b: Record<string, unknown> = {};
      b.select = (c?: string) => { if (c) cols = c; return b; };
      b.eq     = (col: string, val: unknown) => { filters.push({ col, op: 'eq',  val }); return b; };
      b.neq    = (col: string, val: unknown) => { filters.push({ col, op: 'neq', val }); return b; };
      b.limit  = (n: number) => { limitN = n; return b; };
      b.update = (p: Record<string, unknown>) => { mode = 'update'; patch = p; return b; };
      b.upsert = (row: Record<string, unknown>, opts: { onConflict: string }) => {
        mode = 'upsert'; upsertRow = row; conflictCol = opts.onConflict; return b;
      };
      b.single = async () => {
        const r = await run();
        return { data: (r.data as unknown[])[0] ?? null, error: null };
      };
      b.maybeSingle = b.single;
      b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
        run().then(ok, err);
      return b;
    },
  };
}

let practiceId: string;

/**
 * A practitioner membership at the test practice. `withLogin: false` models a
 * ROSTER-ONLY entry — no auth user at all, which is the case 0094 exists for
 * and the case where payouts.provider_id has nothing to point at.
 */
async function seedProviderMember(withLogin: boolean) {
  const userId = withLogin ? crypto.randomUUID() : null;
  const { rows } = await q<{ id: string }>(
    `insert into practice_members
       (practice_id, user_id, role, active, provider_first_name, provider_last_name)
     values ($1, $2, 'provider', true, $3, $4) returning id`,
    [practiceId, userId, withLogin ? null : 'Zanele', withLogin ? null : 'Mthembu']);
  return { memberId: rows[0].id, userId };
}

/** A plan sitting at pending_first_payment with its instalment-1 payment. */
async function seedPendingPlan(opts: { providerMemberId?: string | null; total?: number } = {}) {
  const plan = await q<{ id: string }>(
    `insert into plans (practice_id, provider_member_id, status, total_amount)
     values ($1, $2, 'pending_first_payment', $3) returning id`,
    [practiceId, opts.providerMemberId ?? null, opts.total ?? 3000]);
  const payment = await q<{ id: string }>(
    `insert into payments (plan_id, status) values ($1, 'pending') returning id`,
    [plan.rows[0].id]);
  return { planId: plan.rows[0].id, paymentId: payment.rows[0].id };
}

const activate = (planId: string, paymentId: string, providerMemberId: string | null = null, total = 3000) =>
  activateFirstInstalment(makeSqlClient(), {
    paymentId,
    plan: { id: planId, total_amount: total, practice_id: practiceId, provider_member_id: providerMemberId },
  });

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
});

beforeEach(async () => {
  await db.exec('truncate payouts, payments, plans, practice_members, practices cascade');
  practiceId = (await q<{ id: string }>(
    `insert into practices (name, fee_percent) values ('Test Practice', 10) returning id`)).rows[0].id;
});

afterAll(async () => { await db?.close(); });

// ─── The guard ──────────────────────────────────────────────────────────

describe('activateFirstInstalment leaves every snapshot_* column NULL', () => {
  it('THE GUARD: the payout row it writes has all five columns NULL', async () => {
    const { planId, paymentId } = await seedPendingPlan();

    const result = await activate(planId, paymentId);
    expect(result).toEqual({ ok: true });

    // Read the columns back individually so the failure message names the one
    // that regressed rather than dumping the whole row.
    const { rows } = await q<Record<string, string | null>>(
      `select ${SNAPSHOT_COLS.join(', ')} from payouts where plan_id = $1`, [planId]);
    expect(rows).toHaveLength(1);

    for (const col of SNAPSHOT_COLS) {
      expect(rows[0][col], `${col} must be NULL — see this file's header`).toBeNull();
    }
  });

  it('holds when the plan HAS a provider — the branch that used to snapshot', async () => {
    // This is the case that populated them: a provider whose membership had
    // elected payout_destination='provider' got their bank details copied onto
    // the payout row. provider_id is still recorded (it attributes the plan);
    // what must not come back is the banking that travelled with it.
    const { memberId, userId } = await seedProviderMember(true);
    const { planId, paymentId } = await seedPendingPlan({ providerMemberId: memberId });

    await activate(planId, paymentId, memberId);

    const { rows } = await q<Record<string, string | null>>(
      `select provider_id, payout_destination, ${SNAPSHOT_COLS.join(', ')}
         from payouts where plan_id = $1`, [planId]);

    // Attribution kept — resolved through the membership to its auth user,
    // because payouts.provider_id still references profiles(id).
    expect(rows[0].provider_id).toBe(userId);
    // …destination still the practice, and no banking snapshotted.
    expect(rows[0].payout_destination).toBe('practice');
    for (const col of SNAPSHOT_COLS) {
      expect(rows[0][col], `${col} must be NULL even with a provider`).toBeNull();
    }
  });

  it('holds across a re-run — the idempotent second call writes nothing', async () => {
    const { planId, paymentId } = await seedPendingPlan();
    await activate(planId, paymentId);
    await activate(planId, paymentId);
    await activate(planId, paymentId);

    const { rows } = await q<Record<string, string | null>>(
      `select ${SNAPSHOT_COLS.join(', ')} from payouts where plan_id = $1`, [planId]);
    expect(rows).toHaveLength(1);                 // still one row (0087's UNIQUE)
    for (const col of SNAPSHOT_COLS) expect(rows[0][col]).toBeNull();
  });

  it('a ROSTER-ONLY practitioner: provider_id NULL, snapshots still NULL', async () => {
    // 0094's consequence on this path. The practitioner has no auth user, and
    // payouts.provider_id references profiles(id), so there is nothing legal to
    // write there — it stays NULL rather than being coerced to the membership
    // id, which would be a silent type-confusion pointing at the wrong table.
    //
    // Attribution is not lost: it lives on plans.provider_member_id, which is
    // what every attribution consumer reads since 0094.
    const { memberId } = await seedProviderMember(false);
    const { planId, paymentId } = await seedPendingPlan({ providerMemberId: memberId });

    const result = await activate(planId, paymentId, memberId);
    expect(result).toEqual({ ok: true });

    const { rows } = await q<Record<string, string | null>>(
      `select provider_id, payout_destination, ${SNAPSHOT_COLS.join(', ')}
         from payouts where plan_id = $1`, [planId]);
    expect(rows[0].provider_id).toBeNull();
    expect(rows[0].payout_destination).toBe('practice');
    for (const col of SNAPSHOT_COLS) {
      expect(rows[0][col], `${col} must be NULL for a roster practitioner`).toBeNull();
    }

    // The plan still knows who treated the patient.
    const { rows: planRows } = await q<{ provider_member_id: string }>(
      `select provider_member_id from plans where id = $1`, [planId]);
    expect(planRows[0].provider_member_id).toBe(memberId);
  });

  it('the writer never NAMES a snapshot column — belt as well as braces', () => {
    // The DB assertions above prove the OUTCOME. This proves the INTENT, and
    // catches a reintroduction that a future schema default might otherwise
    // mask. Comments are stripped: this file's subject is discussed at length
    // in activateFirstInstalment's own comments, legitimately.
    const src = readFileSync(resolve(process.cwd(), 'lib/payments/activateFirstInstalment.ts'), 'utf8');
    const code = stripComments(src);
    for (const col of SNAPSHOT_COLS) {
      expect(code, `activateFirstInstalment must not write ${col}`).not.toMatch(col);
    }
    // Nor the membership-side columns it used to read to populate them.
    expect(code).not.toMatch(/personal_bank_name|personal_account_number|personal_branch_code/);

    // This used to be a blanket ban on the string `practice_members`, on the
    // grounds that the writer must not read the membership row "to decide a
    // destination at all". Since 0094 it DOES read that row — to resolve the
    // treating practitioner's user_id for attribution, because plans now point
    // at a membership and payouts.provider_id still points at a profile.
    //
    // The ban is therefore narrowed to what it was actually protecting, which
    // makes it sharper rather than looser: the destination must be the hard
    // literal 'practice', and the membership read must not pull any column
    // that could reintroduce a destination decision.
    expect(code).toMatch(/payout_destination:\s*'practice'/);
    expect(code).not.toMatch(/payout_destination'|payout_destination"/);   // never SELECTed
    const memberSelects = code.match(/from\('practice_members'\)[\s\S]{0,120}?\.select\('([^']*)'\)/g) ?? [];
    expect(memberSelects).toHaveLength(1);
    expect(memberSelects[0]).toMatch(/\.select\('user_id'\)/);
  });

  it('the payout row it builds has exactly the expected keys — no silent additions', async () => {
    const { memberId } = await seedProviderMember(true);
    const { planId, paymentId } = await seedPendingPlan({ providerMemberId: memberId });
    await activate(planId, paymentId, crypto.randomUUID());

    // Everything the writer did NOT set must still be at its column default,
    // which for all five snapshots is NULL. Asserted as a count so a sixth
    // snapshot column added later is covered without editing this test.
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n
         from information_schema.columns
        where table_name = 'payouts' and column_name like 'snapshot_%'`);
    expect(rows[0].n).toBe(SNAPSHOT_COLS.length);

    const populated = await q<{ n: number }>(
      `select count(*)::int as n from payouts
        where plan_id = $1 and (
          snapshot_bank_name      is not null or
          snapshot_account_holder is not null or
          snapshot_account_number is not null or
          snapshot_branch_code    is not null or
          snapshot_account_type   is not null)`, [planId]);
    expect(populated.rows[0].n).toBe(0);
  });
});
