// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { declineCheckoutSessionsForPlan } from './declineCheckoutSessions';

// ─── Real-database test: plan decline → session decline ───────────────────
//
// The properties this feature is judged on are all DATABASE properties — does
// the UPDATE match the right rows, does it leave terminal rows alone, is a
// second call a no-op, does 'declined' even satisfy the constraint. A fake
// client can only ever confirm which builder methods were called, so the
// helper is driven here against a real in-process Postgres (pglite) through a
// minimal PostgREST shim, with the stage CHECK CONSTRAINT LIFTED VERBATIM OUT
// OF MIGRATION 0085 — so if someone narrows that constraint, this fails
// rather than passing against a friendlier hand-written copy.

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0085_checkout_sessions.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

/** The real constraint text, not a paraphrase of it. */
const STAGE_CHECK = (() => {
  const m = MIG.match(/CHECK \(stage IN \([^)]*\)\)/);
  if (!m) throw new Error('stage CHECK not found in migration 0085 — has the column changed?');
  return m[0];
})();

const SCHEMA = `
  create table plans (
    id     uuid primary key default gen_random_uuid(),
    status text not null
  );
  create table checkout_sessions (
    id         uuid primary key default gen_random_uuid(),
    token      text unique not null,
    plan_id    uuid not null references plans(id),
    stage      text not null default 'created' ${STAGE_CHECK},
    expires_at timestamptz not null default now()
  );
`;

const MODELLED = new Set(['checkout_sessions']);

/**
 * Minimal PostgREST-over-pglite shim — same local-shim approach as
 * lib/practice/setupChecklist.pglite.test.ts. Only the four builder calls the
 * helper actually makes are modelled; anything else throws rather than
 * silently letting the test pass on a query it never ran.
 */
function shim(db: PGlite) {
  return {
    from(table: string) {
      if (!MODELLED.has(table)) {
        throw new Error(`[shim] unmodelled table "${table}"`);
      }
      let patch: Record<string, unknown> = {};
      const eq: Array<[string, unknown]> = [];
      let inClause: [string, unknown[]] | null = null;

      const builder = {
        update(next: Record<string, unknown>) { patch = next; return builder; },
        eq(col: string, val: unknown) { eq.push([col, val]); return builder; },
        in(col: string, vals: unknown[]) { inClause = [col, vals]; return builder; },
        async select(cols: string) {
          const params: unknown[] = [];
          const sets = Object.entries(patch).map(([c, v]) => {
            params.push(v);
            return `${c} = $${params.length}`;
          });
          const where: string[] = [];
          for (const [c, v] of eq) {
            params.push(v);
            where.push(`${c} = $${params.length}`);
          }
          if (inClause) {
            const [c, vals] = inClause as [string, unknown[]];
            const holes = vals.map((v) => { params.push(v); return `$${params.length}`; });
            where.push(`${c} in (${holes.join(', ')})`);
          }
          const sql =
            `update ${table} set ${sets.join(', ')}` +
            (where.length ? ` where ${where.join(' and ')}` : '') +
            ` returning ${cols}`;
          try {
            const res = await db.query(sql, params);
            return { data: res.rows as Array<Record<string, unknown>>, error: null };
          } catch (e) {
            return { data: null, error: { message: (e as Error).message } };
          }
        },
      };
      return builder;
    },
  };
}

let db: PGlite;
let client: ReturnType<typeof shim>;

async function seedPlan(status = 'declined'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into plans (status) values ($1) returning id`, [status],
  );
  return r.rows[0].id;
}

async function seedSession(planId: string, token: string, stage: string): Promise<void> {
  await db.query(
    `insert into checkout_sessions (token, plan_id, stage) values ($1, $2, $3)`,
    [token, planId, stage],
  );
}

async function stageOf(token: string): Promise<string> {
  const r = await db.query<{ stage: string }>(
    `select stage from checkout_sessions where token = $1`, [token],
  );
  return r.rows[0].stage;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  client = shim(db);
});

describe('declineCheckoutSessionsForPlan — the till-issued bill it exists for', () => {
  it('moves a still-open session to declined', async () => {
    const planId = await seedPlan();
    await seedSession(planId, 'tok-created', 'created');

    const result = await declineCheckoutSessionsForPlan(planId, client);

    expect(result).toEqual({ declined: 1, error: null });
    expect(await stageOf('tok-created')).toBe('declined');
  });

  it('moves a SCANNED session too — the patient got as far as their phone', async () => {
    const planId = await seedPlan();
    await seedSession(planId, 'tok-scanned', 'scanned');
    expect(await declineCheckoutSessionsForPlan(planId, client)).toEqual({ declined: 1, error: null });
    expect(await stageOf('tok-scanned')).toBe('declined');
  });

  it("'declined' satisfies the constraint migration 0085 actually shipped", async () => {
    // Belt-and-braces on the premise of the whole change: the stage was
    // designed and never connected. If the CHECK had never permitted it, every
    // test above would fail on a constraint violation rather than on logic.
    expect(STAGE_CHECK).toContain("'declined'");
  });
});

describe('declineCheckoutSessionsForPlan — never rewrites a terminal stage', () => {
  it('leaves a COMPLETED session alone — the money moved', async () => {
    const planId = await seedPlan();
    await seedSession(planId, 'tok-done', 'completed');

    const result = await declineCheckoutSessionsForPlan(planId, client);

    expect(result).toEqual({ declined: 0, error: null });
    expect(await stageOf('tok-done')).toBe('completed');
  });

  it('leaves an EXPIRED session alone — expired is already truthful and terminal', async () => {
    // The decision the task asked to be justified: a session that ran out of
    // time (or that the teller abandoned) describes what happened AT THE TILL,
    // which is the only thing this row is about. Overwriting it with 'declined'
    // would trade one true fact for another and lose the first.
    const planId = await seedPlan();
    await seedSession(planId, 'tok-expired', 'expired');

    expect(await declineCheckoutSessionsForPlan(planId, client)).toEqual({ declined: 0, error: null });
    expect(await stageOf('tok-expired')).toBe('expired');
  });

  it('is idempotent — declining twice is safe and the second call moves nothing', async () => {
    const planId = await seedPlan();
    await seedSession(planId, 'tok-twice', 'created');

    const first  = await declineCheckoutSessionsForPlan(planId, client);
    const second = await declineCheckoutSessionsForPlan(planId, client);

    expect(first.declined).toBe(1);
    expect(second.declined).toBe(0);
    expect(second.error).toBeNull();
    expect(await stageOf('tok-twice')).toBe('declined');
  });
});

describe('declineCheckoutSessionsForPlan — the email-issued bill', () => {
  it('is a clean no-op when the plan has no session at all, not an error', async () => {
    // createBill + patient_invitations issues bills with zero
    // checkout_sessions rows. This is the COMMON case, since declinePlan is
    // reachable today only for invitation-issued plans — so "no rows" must
    // read as normal, never as a failure.
    const planId = await seedPlan();
    expect(await declineCheckoutSessionsForPlan(planId, client)).toEqual({ declined: 0, error: null });
  });

  it('never touches another plan\'s session', async () => {
    const mine    = await seedPlan();
    const someone = await seedPlan('pending_acceptance');
    await seedSession(someone, 'tok-theirs', 'created');

    expect(await declineCheckoutSessionsForPlan(mine, client)).toEqual({ declined: 0, error: null });
    expect(await stageOf('tok-theirs')).toBe('created');
  });
});

describe('declineCheckoutSessionsForPlan — several sessions on one plan', () => {
  it('closes every open one and leaves every terminal one, in a single call', async () => {
    // issueCounterSession mints a FRESH plan per session, so one plan has at
    // most one today — but plan_id carries no unique constraint, so the schema
    // permits more. Asserted so the predicate is known to work on a set
    // rather than accidentally on exactly-one-row.
    const planId = await seedPlan();
    await seedSession(planId, 'm-created',   'created');
    await seedSession(planId, 'm-scanned',   'scanned');
    await seedSession(planId, 'm-completed', 'completed');
    await seedSession(planId, 'm-expired',   'expired');

    const result = await declineCheckoutSessionsForPlan(planId, client);

    expect(result).toEqual({ declined: 2, error: null });
    expect(await stageOf('m-created')).toBe('declined');
    expect(await stageOf('m-scanned')).toBe('declined');
    expect(await stageOf('m-completed')).toBe('completed');
    expect(await stageOf('m-expired')).toBe('expired');
  });
});
