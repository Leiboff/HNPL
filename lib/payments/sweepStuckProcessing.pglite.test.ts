// @vitest-environment node
//
// ─── The safety net under every claim (A-13) ───────────────────────────────
//
// A `payments` row left in 'processing' is invisible to every automated path
// in the system: attemptChargeInstalment claims only scheduled/failed/
// defaulted, the collection cron selects only scheduled and failed, and
// assessDunningFee looks only at failed. So a stranded claim is not a stalled
// payment — it is a permanent, silent write-off of everything it covers, on a
// plan that then never completes, never defaults, and never freezes the
// customer.
//
// The sweep is written against real Postgres because half of what it relies
// on is 0132's triggers: processing_since and pre_claim_status are maintained
// by the database precisely so no claimer can forget them, and a stubbed
// client would let this suite pass with the triggers deleted.
//
// ─── THE TWO TIERS, WHICH ARE THE WHOLE DESIGN ─────────────────────────────
//
// The audit's suggested fix was "on a transport error, revert like the
// rejected branch does". That is not safe, and the tests below are arranged
// around why: a transport error means the RESPONSE did not arrive, not that
// the charge did not happen. Reverting a claim Peach is about to collect
// charges the customer twice for the same money.
//
//   provider_attempted_at IS NULL       nothing was ever sent. Revert.
//   provider_attempted_at IS NOT NULL   may be in flight. Report, never touch.
//
// This Peach client has no payment-status query on the recurring surface, so
// tier 2 genuinely cannot be resolved in code — it goes to a human with the
// Peach dashboard. That is not a lesser fix: the defect was never "somebody
// has to check four rows", it was that nobody knew the rows existed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sweepStuckProcessing, STUCK_PROCESSING_HOURS } from './sweepStuckProcessing';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0132_processing_claim_provenance.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const PATIENT = '0000aa00-0000-0000-0000-0000000000aa';

const SCHEMA = `
  create table plans (
    id uuid primary key,
    patient_id uuid,
    status text not null,
    total_amount numeric(10,2)
  );

  create table payments (
    id uuid primary key default gen_random_uuid(),
    plan_id uuid references plans(id),
    patient_id uuid,
    instalment_number integer not null,
    amount numeric(10,2) not null,
    due_date date not null,
    status text not null default 'scheduled',
    kind text not null default 'instalment',
    peach_payment_id text,
    failure_reason text,
    collected_at timestamptz,
    settled_by_payment_id uuid,
    pre_settlement_snapshot jsonb,
    created_at timestamptz not null default now()
  );

  create table plan_events (
    id uuid primary key default gen_random_uuid(),
    plan_id uuid,
    patient_id uuid,
    event_type text,
    payload jsonb,
    created_at timestamptz not null default now()
  );
`;

let db: PGlite;

/**
 * The narrowest Supabase-shaped adapter over pglite that the sweep exercises.
 * Deliberately not a general translator — it resolves exactly the queries
 * sweepStuckProcessing issues, so a change to its read pattern fails loudly
 * here rather than silently answering something else.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function client(): any {
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

  return {
    from(table: string) {
      const wheres: string[] = [];
      const params: unknown[] = [];
      let columns = '*';
      let mode: 'select' | 'update' | 'insert' = 'select';
      let setSql = '';

      const push = (frag: string, value: unknown) => {
        params.push(value);
        wheres.push(frag.replace('$?', `$${params.length}`));
      };

      const run = async () => {
        const where = wheres.length ? ` where ${wheres.join(' and ')}` : '';
        if (mode === 'update') {
          const rows = await q(`update ${table} set ${setSql}${where} returning ${columns}`, params);
          return { data: rows.rows, error: null };
        }
        const rows = await q(`select ${columns} from ${table}${where}`, params);
        return { data: rows.rows, error: null };
      };

      const builder = {
        select(cols?: string) { if (cols) columns = cols; return builder; },
        update(row: Record<string, unknown>) {
          mode = 'update';
          const sets: string[] = [];
          for (const [k, v] of Object.entries(row)) { params.push(v); sets.push(`${k} = $${params.length}`); }
          setSql = sets.join(', ');
          return builder;
        },
        async insert(row: Record<string, unknown>) {
          const keys = Object.keys(row);
          const vals = keys.map((_, i) => `$${i + 1}`);
          await q(`insert into ${table} (${keys.join(', ')}) values (${vals.join(', ')})`, Object.values(row));
          return { data: null, error: null };
        },
        eq(col: string, v: unknown)  { push(`${col} = $?`, v);  return builder; },
        lt(col: string, v: unknown)  { push(`${col} < $?`, v);  return builder; },
        neq(col: string, v: unknown) { push(`${col} <> $?`, v); return builder; },
        in(col: string, vs: unknown[]) {
          const slots = vs.map((v) => { params.push(v); return `$${params.length}`; });
          wheres.push(`${col} in (${slots.join(', ') || 'null'})`);
          return builder;
        },
        not(col: string, _op: string, v: unknown) {
          wheres.push(v === null ? `${col} is not null` : `${col} is distinct from '${String(v)}'`);
          return builder;
        },
        async maybeSingle() { const r = await run(); return { data: (r.data as unknown[])[0] ?? null, error: null }; },
        then(resolve: (v: unknown) => unknown) { return run().then(resolve); },
      };
      return builder;
    },
  };
}

const PLAN_ACTIVE  = '11110000-0000-0000-0000-000000001111';
const PLAN_PENDING = '22220000-0000-0000-0000-000000002222';

async function seed() {
  await db.exec(`
    insert into plans (id, patient_id, status, total_amount) values
      ('${PLAN_ACTIVE}',  '${PATIENT}', 'active', 9000),
      ('${PLAN_PENDING}', '${PATIENT}', 'pending_first_payment', 9000);
  `);
}

/** Insert a row, claim it into 'processing' so the trigger stamps it, then age it. */
async function stuckRow(opts: {
  id: string;
  plan?: string;
  from?: string;
  instalment?: number;
  kind?: string;
  attempted?: boolean;
  hoursAgo?: number;
  settledBy?: string | null;
}) {
  const plan = opts.plan ?? PLAN_ACTIVE;
  await db.exec(`
    insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
    values ('${opts.id}', '${plan}', '${PATIENT}', ${opts.instalment ?? 2}, 3000, '2026-08-01',
            '${opts.from ?? 'scheduled'}', '${opts.kind ?? 'instalment'}');
  `);
  await db.exec(`
    update payments set status = 'processing'
      ${opts.settledBy ? `, settled_by_payment_id = '${opts.settledBy}'` : ''}
     where id = '${opts.id}';
  `);
  if (opts.attempted) {
    await db.exec(`update payments set provider_attempted_at = now() where id = '${opts.id}';`);
  }
  const hours = opts.hoursAgo ?? 48;
  await db.exec(`
    update payments
       set processing_since = now() - interval '${hours} hours',
           provider_attempted_at = CASE WHEN provider_attempted_at IS NULL THEN NULL
                                        ELSE now() - interval '${hours} hours' END
     where id = '${opts.id}';
  `);
}

const statusOf = async (id: string): Promise<string> =>
  ((await db.query(`select status from payments where id = $1`, [id])).rows[0] as { status: string }).status;

const rowOf = async (id: string) =>
  (await db.query(`select * from payments where id = $1`, [id])).rows[0] as Record<string, unknown>;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG);
  await seed();
}, 60_000);

afterEach(async () => { await db?.close(); });

// ─── 0132's triggers, which the sweep is built on ─────────────────────────

describe('the provenance the database maintains for itself', () => {
  it('stamps processing_since and pre_claim_status on the way in', async () => {
    await db.exec(`
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status)
      values ('aaaa0000-0000-0000-0000-00000000aaaa', '${PLAN_ACTIVE}', '${PATIENT}', 2, 3000, '2026-08-01', 'failed');
      update payments set status = 'processing' where id = 'aaaa0000-0000-0000-0000-00000000aaaa';
    `);
    const row = await rowOf('aaaa0000-0000-0000-0000-00000000aaaa');
    expect(row.processing_since).not.toBeNull();
    // The fact chargeInstalment kept in a local variable — which is exactly
    // what a process that dies mid-flight loses.
    expect(row.pre_claim_status).toBe('failed');
  });

  it('clears the clock on the way out, so a collected row can never look stale', async () => {
    await db.exec(`
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status)
      values ('bbbb0000-0000-0000-0000-00000000bbbb', '${PLAN_ACTIVE}', '${PATIENT}', 2, 3000, '2026-08-01', 'scheduled');
      update payments set status = 'processing' where id = 'bbbb0000-0000-0000-0000-00000000bbbb';
      update payments set status = 'collected'  where id = 'bbbb0000-0000-0000-0000-00000000bbbb';
    `);
    const row = await rowOf('bbbb0000-0000-0000-0000-00000000bbbb');
    expect(row.processing_since).toBeNull();
    expect(row.provider_attempted_at).toBeNull();
    // Kept, though — it is evidence, and it costs nothing.
    expect(row.pre_claim_status).toBe('scheduled');
  });

  it('a re-claim starts a fresh attempt rather than inheriting the last one', async () => {
    // Otherwise a row claimed, attempted, released and claimed again would
    // look already-sent on its second strand, and the sweep would refuse to
    // revert something that never left the building.
    await db.exec(`
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status)
      values ('cccc0000-0000-0000-0000-00000000cccc', '${PLAN_ACTIVE}', '${PATIENT}', 2, 3000, '2026-08-01', 'scheduled');
      update payments set status = 'processing' where id = 'cccc0000-0000-0000-0000-00000000cccc';
      update payments set provider_attempted_at = now() where id = 'cccc0000-0000-0000-0000-00000000cccc';
      update payments set status = 'failed'     where id = 'cccc0000-0000-0000-0000-00000000cccc';
      update payments set status = 'processing' where id = 'cccc0000-0000-0000-0000-00000000cccc';
    `);
    const row = await rowOf('cccc0000-0000-0000-0000-00000000cccc');
    expect(row.provider_attempted_at).toBeNull();
    expect(row.pre_claim_status).toBe('failed');
  });

  it('stamps a row INSERTED straight into processing', async () => {
    // Instalment 1 of a fresh schedule and every settlement row arrive this
    // way. Without the INSERT trigger they would read NULL and the sweep
    // would never see them at all.
    await db.exec(`
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
      values ('dddd0000-0000-0000-0000-00000000dddd', '${PLAN_ACTIVE}', '${PATIENT}', 0, 6000, '2026-08-01', 'processing', 'settlement');
    `);
    const row = await rowOf('dddd0000-0000-0000-0000-00000000dddd');
    expect(row.processing_since).not.toBeNull();
    expect(row.pre_claim_status).toBeNull();   // it had none
  });
});

// ─── Tier 1 — revert what was never sent ──────────────────────────────────

describe('a claim that died before the provider call is put back', () => {
  it('restores the exact status it was claimed from', async () => {
    // Not a guess. 'failed' back to 'failed' keeps it in the dunning ladder;
    // 'scheduled' back to 'scheduled' keeps it out of one.
    await stuckRow({ id: 'e1110000-0000-0000-0000-0000000000e1', from: 'failed' });
    await stuckRow({ id: 'e2220000-0000-0000-0000-0000000000e2', from: 'scheduled' });

    const summary = await sweepStuckProcessing(client());
    expect(summary.reverted).toBe(2);
    expect(await statusOf('e1110000-0000-0000-0000-0000000000e1')).toBe('failed');
    expect(await statusOf('e2220000-0000-0000-0000-0000000000e2')).toBe('scheduled');
  });

  it('clears the dead reference and says why in failure_reason', async () => {
    await stuckRow({ id: 'e3330000-0000-0000-0000-0000000000e3', from: 'failed' });
    await db.exec(`update payments set peach_payment_id = 'REF123' where id = 'e3330000-0000-0000-0000-0000000000e3';`);

    await sweepStuckProcessing(client());
    const row = await rowOf('e3330000-0000-0000-0000-0000000000e3');
    expect(row.peach_payment_id).toBeNull();
    expect(String(row.failure_reason)).toMatch(/never sent to provider/);
  });

  it('records it on the plan timeline — a revert moves a money position', async () => {
    await stuckRow({ id: 'e4440000-0000-0000-0000-0000000000e4', from: 'failed' });
    await sweepStuckProcessing(client());
    const events = await db.query(`select event_type, payload from plan_events;`);
    expect(events.rows).toHaveLength(1);
    const ev = events.rows[0] as { event_type: string; payload: Record<string, unknown> };
    expect(ev.event_type).toBe('stuck_claim_reverted');
    expect(ev.payload.restored_to).toBe('failed');
    expect(ev.payload.reason).toBe('claim_never_sent');
  });

  it('leaves a row that has not been stuck long enough alone', async () => {
    await stuckRow({ id: 'e5550000-0000-0000-0000-0000000000e5', from: 'failed', hoursAgo: 1 });
    const summary = await sweepStuckProcessing(client());
    expect(summary.scanned).toBe(0);
    expect(await statusOf('e5550000-0000-0000-0000-0000000000e5')).toBe('processing');
  });

  it('the window is the shared constant, and a caller can tighten it', async () => {
    expect(STUCK_PROCESSING_HOURS).toBe(6);
    await stuckRow({ id: 'e6660000-0000-0000-0000-0000000000e6', from: 'failed', hoursAgo: 2 });
    expect((await sweepStuckProcessing(client())).scanned).toBe(0);
    expect((await sweepStuckProcessing(client(), { hours: 1 })).reverted).toBe(1);
  });
});

// ─── Tier 2 — never touch what may be in flight ───────────────────────────

describe('a claim that reached the provider is reported, never reverted', () => {
  it('leaves it in processing and names it for a human', async () => {
    // The heart of the finding. Reverting here would release the
    // instalments while Peach collects them — the customer pays and still
    // owes the money, which is worse than the freeze this fixes.
    await stuckRow({ id: 'f1110000-0000-0000-0000-0000000000f1', from: 'failed', attempted: true });

    const summary = await sweepStuckProcessing(client());
    expect(summary.reverted).toBe(0);
    expect(summary.needs_reconciliation).toBe(1);
    expect(summary.needs_reconciliation_ids).toEqual(['f1110000-0000-0000-0000-0000000000f1']);
    expect(await statusOf('f1110000-0000-0000-0000-0000000000f1')).toBe('processing');
  });

  it('sorts a mixed batch into the two tiers', async () => {
    await stuckRow({ id: 'f2220000-0000-0000-0000-0000000000f2', from: 'failed' });
    await stuckRow({ id: 'f3330000-0000-0000-0000-0000000000f3', from: 'failed', attempted: true });
    await stuckRow({ id: 'f4440000-0000-0000-0000-0000000000f4', from: 'scheduled' });

    const summary = await sweepStuckProcessing(client());
    expect(summary.scanned).toBe(3);
    expect(summary.reverted).toBe(2);
    expect(summary.needs_reconciliation).toBe(1);
  });
});

// ─── Settlements — one row holding a whole plan's balance ─────────────────

describe('a settlement claim that never went out releases everything it held', () => {
  const SETTLEMENT = 'aaaa1111-0000-0000-0000-00000000a111';
  const COVERED_A  = 'bbbb1111-0000-0000-0000-00000000b111';
  const COVERED_B  = 'bbbb2222-0000-0000-0000-00000000b222';

  async function seedSettlement(attempted = false) {
    await db.exec(`
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
      values ('${COVERED_A}', '${PLAN_ACTIVE}', '${PATIENT}', 2, 3000, '2026-08-01', 'failed', 'instalment'),
             ('${COVERED_B}', '${PLAN_ACTIVE}', '${PATIENT}', 3, 3000, '2026-09-01', 'scheduled', 'instalment');

      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind, pre_settlement_snapshot)
      values ('${SETTLEMENT}', '${PLAN_ACTIVE}', '${PATIENT}', 0, 6000, '2026-08-01', 'processing', 'settlement',
              jsonb_build_object(
                '${COVERED_A}', jsonb_build_object('status', 'failed'),
                '${COVERED_B}', jsonb_build_object('status', 'scheduled')
              ));

      update payments set status = 'processing', settled_by_payment_id = '${SETTLEMENT}'
       where id in ('${COVERED_A}', '${COVERED_B}');

      update payments
         set processing_since = now() - interval '48 hours'
       where id in ('${SETTLEMENT}', '${COVERED_A}', '${COVERED_B}');
    `);
    if (attempted) {
      await db.exec(`
        update payments set provider_attempted_at = now() - interval '48 hours'
         where id = '${SETTLEMENT}';`);
    }
  }

  it('fails the settlement and restores each instalment to its SNAPSHOT status', async () => {
    // Not a blanket 'failed'. The snapshot is what makes the revert an undo
    // rather than a second opinion — the scheduled one goes back to
    // scheduled, so no dunning fee is assessed for a failure that never
    // happened.
    await seedSettlement();

    const summary = await sweepStuckProcessing(client());
    expect(summary.reverted).toBe(1);
    expect(summary.covered_reverted).toBe(2);
    expect(await statusOf(SETTLEMENT)).toBe('failed');
    expect(await statusOf(COVERED_A)).toBe('failed');
    expect(await statusOf(COVERED_B)).toBe('scheduled');
  });

  it('unlinks them, so nothing still claims rows it no longer holds', async () => {
    await seedSettlement();
    await sweepStuckProcessing(client());
    for (const id of [COVERED_A, COVERED_B]) {
      expect((await rowOf(id)).settled_by_payment_id).toBeNull();
    }
  });

  it('the balance is collectable again — the write-off is undone', async () => {
    // The actual harm A-13 describes: the cron selects only scheduled and
    // failed, so while these sat in 'processing' the plan's whole remaining
    // balance was uncollectable forever.
    await seedSettlement();
    await sweepStuckProcessing(client());
    const collectable = await db.query(`
      select count(*)::int as n from payments
       where plan_id = '${PLAN_ACTIVE}' and kind = 'instalment' and status in ('scheduled','failed');`);
    expect((collectable.rows[0] as { n: number }).n).toBe(2);
  });

  it('but a settlement that DID reach Peach freezes intact, children included', async () => {
    // The double-charge guard, at its most consequential: one settlement row
    // covers the entire outstanding balance, so releasing it on a guess
    // would re-collect a whole plan.
    await seedSettlement(true);

    const summary = await sweepStuckProcessing(client());
    expect(summary.needs_reconciliation).toBe(1);
    expect(summary.reverted).toBe(0);
    expect(summary.covered_reverted).toBe(0);
    expect(await statusOf(SETTLEMENT)).toBe('processing');
    expect(await statusOf(COVERED_A)).toBe('processing');
    expect(await statusOf(COVERED_B)).toBe('processing');
  });

  it('a covered row orphaned by an already-resolved settlement is released', async () => {
    // The gap between the webhook's revert and this one: the webhook only
    // touches rows still linked and still processing, so a write that failed
    // halfway leaves a child behind. The parent's snapshot still knows what
    // it was.
    await seedSettlement();
    await db.exec(`update payments set status = 'failed' where id = '${SETTLEMENT}';`);
    await db.exec(`
      update payments set status = 'failed', settled_by_payment_id = null
       where id = '${COVERED_A}';`);

    const summary = await sweepStuckProcessing(client());
    expect(summary.reverted).toBe(1);
    expect(await statusOf(COVERED_B)).toBe('scheduled');
  });
});

// ─── The carve-out ────────────────────────────────────────────────────────

describe('a live resumable checkout is not a stranded claim', () => {
  it('leaves instalment 1 of a pending_first_payment plan alone', async () => {
    // It sits in 'processing' BY DESIGN while the patient is in the Peach
    // widget, and the resume path re-uses this exact row so the
    // deterministic reference is identical and Peach dedups. Reverting it
    // would break the resume in order to fix a problem it does not have.
    await stuckRow({
      id: 'c1110000-0000-0000-0000-0000000000c1',
      plan: PLAN_PENDING, instalment: 1, from: 'scheduled',
    });

    const summary = await sweepStuckProcessing(client());
    expect(summary.skipped_resumable).toBe(1);
    expect(summary.reverted).toBe(0);
    expect(await statusOf('c1110000-0000-0000-0000-0000000000c1')).toBe('processing');
  });

  it('but instalment 2 of the same plan is NOT carved out', async () => {
    // The carve-out is about the ONE row the checkout widget is charging,
    // not about the plan. Nothing else on a pending_first_payment plan has
    // any business sitting in 'processing'.
    await stuckRow({
      id: 'c2220000-0000-0000-0000-0000000000c2',
      plan: PLAN_PENDING, instalment: 2, from: 'scheduled',
    });
    const summary = await sweepStuckProcessing(client());
    expect(summary.skipped_resumable).toBe(0);
    expect(summary.reverted).toBe(1);
  });

  it('and once the plan goes active, instalment 1 is swept like anything else', async () => {
    await stuckRow({
      id: 'c3330000-0000-0000-0000-0000000000c3',
      plan: PLAN_ACTIVE, instalment: 1, from: 'failed',
    });
    const summary = await sweepStuckProcessing(client());
    expect(summary.skipped_resumable).toBe(0);
    expect(summary.reverted).toBe(1);
  });
});

// ─── Refusing to guess ────────────────────────────────────────────────────

describe('what it will not do', () => {
  it('reports rather than guesses when there is no prior status to restore', async () => {
    // A row INSERTED straight into 'processing' whose plan is no longer
    // pending_first_payment. Guessing 'scheduled' on a past-due row makes
    // the cron charge it; guessing 'failed' posts a dunning fee for a
    // failure that never happened. Neither is a fact, so neither is written.
    await db.exec(`
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
      values ('d1110000-0000-0000-0000-0000000000d1', '${PLAN_ACTIVE}', '${PATIENT}', 1, 3000, '2026-08-01', 'processing', 'instalment');
      update payments set processing_since = now() - interval '48 hours'
       where id = 'd1110000-0000-0000-0000-0000000000d1';
    `);

    const summary = await sweepStuckProcessing(client());
    expect(summary.unrestorable).toBe(1);
    expect(summary.reverted).toBe(0);
    expect(await statusOf('d1110000-0000-0000-0000-0000000000d1')).toBe('processing');
  });

  it('touches nothing that is not in processing', async () => {
    await db.exec(`
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status)
      values ('d2220000-0000-0000-0000-0000000000d2', '${PLAN_ACTIVE}', '${PATIENT}', 2, 3000, '2020-01-01', 'collected'),
             ('d3330000-0000-0000-0000-0000000000d3', '${PLAN_ACTIVE}', '${PATIENT}', 3, 3000, '2020-01-01', 'defaulted');
    `);
    const summary = await sweepStuckProcessing(client());
    expect(summary.scanned).toBe(0);
    expect(await statusOf('d2220000-0000-0000-0000-0000000000d2')).toBe('collected');
    expect(await statusOf('d3330000-0000-0000-0000-0000000000d3')).toBe('defaulted');
  });

  it('is safe to run twice — the second pass finds nothing left to do', async () => {
    // It shares a process with the collection cron, so idempotence is not a
    // nicety: a retried invocation must not re-revert a row somebody has
    // since re-claimed.
    await stuckRow({ id: 'd4440000-0000-0000-0000-0000000000d4', from: 'failed' });
    expect((await sweepStuckProcessing(client())).reverted).toBe(1);
    const second = await sweepStuckProcessing(client());
    expect(second.scanned).toBe(0);
    expect(second.reverted).toBe(0);
  });
});
