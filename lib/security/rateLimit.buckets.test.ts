// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { stripComments } from '@/lib/testing/stripComments';
import { RATE_LIMITS, type RateLimitBucket } from './rateLimit';

// ─── The limiter's own parameters, and the surfaces it now covers ─────────
//
// A-11 had two halves. The sharp one — consume_rate_limit granted to `anon`,
// so the limiter's store was writable by the internet with every parameter
// caller-supplied — was closed by 0125, which revoked it to service_role
// only. Migration 0134 adds the second: clamp the bounds and reject unknown
// buckets inside the function, "so a future accidental grant is less
// useful".
//
// That is defence in depth, and it is worth having precisely because the
// first fix is invisible. A GRANT is one line in a migration nobody reviews
// twice, and before 0134 the function had nothing else protecting it:
// `consume_rate_limit('signup', '<victim IP>', 1000000, 86400)` in a loop
// spent a chosen victim's budget and filled the table. Afterwards the same
// accident buys a hundred rows per call, in a bucket that has to already
// exist.
//
// Run against real Postgres, because every claim here is about what the
// FUNCTION does with its arguments.

const MIG_0124 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0124_rate_limits.sql'), 'utf8',
).replace(/\r\n/g, '\n');
const MIG_0134 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0134_rate_limit_hardening.sql'), 'utf8',
).replace(/\r\n/g, '\n');

let db: PGlite;

const call = async (bucket: string, subject: string | null, max: number, win: number) => {
  const r = await db.query<{ consume_rate_limit: boolean }>(
    'select consume_rate_limit($1, $2, $3, $4)', [bucket, subject, max, win],
  );
  return r.rows[0].consume_rate_limit;
};

const hits = async (bucket: string, subject: string) => {
  const r = await db.query<{ n: number }>(
    'select count(*)::int as n from rate_limit_hits where bucket = $1 and subject = $2',
    [bucket, subject],
  );
  return r.rows[0].n;
};

beforeAll(async () => {
  db = new PGlite();
  // 0124 creates the table and the first version of the function; the
  // grants in both migrations reference roles this harness does not need.
  await db.exec(`
    create role anon          nologin;
    create role authenticated nologin;
    create role service_role  nologin;
  `);
  await db.exec(MIG_0124);
  await db.exec(MIG_0134);
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('the bucket list in SQL matches the one in TypeScript', () => {
  it('every declared bucket is known to the database', async () => {
    // Two lists is a drift risk, accepted for one reason: the database
    // cannot check a bucket against the application by reading it. This test
    // is what makes the duplication safe — a bucket added on one side and
    // not the other fails here rather than silently going unlimited.
    for (const bucket of Object.keys(RATE_LIMITS) as RateLimitBucket[]) {
      const r = await db.query<{ known: boolean }>(
        'select rate_limit_known_bucket($1) as known', [bucket],
      );
      expect(r.rows[0].known, `bucket '${bucket}' is missing from 0134's list`).toBe(true);
    }
  });

  it('and every bucket the database knows is declared in TypeScript', async () => {
    // The other direction: a bucket left in SQL after its call site was
    // deleted is a limit nothing spends, which reads as coverage that is not
    // there.
    const sql = stripComments(MIG_0134);
    const body = sql.slice(sql.indexOf('SELECT p_bucket IN ('), sql.indexOf('$$;'));
    const declared = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const bucket of declared) {
      expect(Object.keys(RATE_LIMITS), `SQL declares '${bucket}' but TypeScript does not`)
        .toContain(bucket);
    }
    expect(new Set(declared)).toEqual(new Set(Object.keys(RATE_LIMITS)));
  });
});

describe('an unknown bucket is not limited, and is not recorded', () => {
  it('permits, so a typo cannot become an outage', async () => {
    // Refusing would turn a misspelled bucket into a denial on a surface
    // nobody meant to guard, which is the failure mode 0124's whole
    // fail-open posture exists to avoid.
    expect(await call('not_a_real_bucket', 'x', 1, 3600)).toBe(true);
    expect(await call('not_a_real_bucket', 'x', 1, 3600)).toBe(true);
  });

  it('writes nothing, so the table cannot be filled with invented buckets', async () => {
    await call('sIgNuP', 'case-sensitive-miss', 1, 3600);
    expect(await hits('not_a_real_bucket', 'x')).toBe(0);
    expect(await hits('sIgNuP', 'case-sensitive-miss')).toBe(0);
  });
});

describe('the bounds are clamped, not trusted', () => {
  it('an absurd p_max cannot mint unbounded budget for a victim', async () => {
    // The targeted-denial shape: spend somebody else's budget before they
    // do. Without the clamp, one call with p_max = 1,000,000 inserts a row
    // every time and the real caller — whose rule says max 10 — is refused
    // for the rest of the window.
    for (let i = 0; i < 1200; i++) await call('signup', 'victim-ip', 1_000_000, 3600);
    // 1000 is the ceiling, so the flood stops there rather than at 1200.
    expect(await hits('signup', 'victim-ip')).toBe(1000);
  });

  it('a negative or zero p_max still permits exactly one', async () => {
    // Clamped up to 1 rather than refused: a rule of zero is a bug at a call
    // site, and a limiter that denies everything is the worst reading of it.
    expect(await call('signup', 'zero-max', 0, 3600)).toBe(true);
    expect(await call('signup', 'zero-max', 0, 3600)).toBe(false);
    expect(await call('signup', 'negative-max', -5, 3600)).toBe(true);
    expect(await call('signup', 'negative-max', -5, 3600)).toBe(false);
  });

  it('an absurd window cannot be used to make a limit permanent', async () => {
    // A sixty-year window would turn a one-hour limit into a lifetime ban on
    // that subject. Clamped to a week.
    //
    // (Anything past 2^31 seconds is refused by the INT parameter type
    // before the clamp is even reached — worth knowing, and not worth
    // relying on: 2,000,000,000 seconds is inside the type and is still
    // sixty-three years.)
    expect(await call('signup', 'long-window', 1, 2_000_000_000)).toBe(true);
    expect(await call('signup', 'long-window', 1, 2_000_000_000)).toBe(false);
    const r = await db.query<{ ok: boolean }>(`
      select (now() - occurred_at) < interval '1 minute' as ok
        from rate_limit_hits where subject = 'long-window'`);
    expect(r.rows[0].ok).toBe(true);
  });

  it('a NULL bound does not throw', async () => {
    const r = await db.query<{ consume_rate_limit: boolean }>(
      'select consume_rate_limit($1, $2, $3, $4)', ['signup', 'null-bounds', null, null],
    );
    expect(r.rows[0].consume_rate_limit).toBe(true);
  });
});

describe('what 0124 already did, still doing it', () => {
  it('permits within budget and refuses past it', async () => {
    for (let i = 0; i < 3; i++) expect(await call('contact_form', 's1', 3, 3600)).toBe(true);
    expect(await call('contact_form', 's1', 3, 3600)).toBe(false);
  });

  it('a null or empty subject is permitted and unrecorded', async () => {
    // An unresolvable IP is our problem, not the caller's — and lumping them
    // into one shared key would let one attacker exhaust the budget for
    // everybody behind a proxy we failed to parse.
    expect(await call('contact_form', null, 1, 3600)).toBe(true);
    expect(await call('contact_form', null, 1, 3600)).toBe(true);
    expect(await call('contact_form', '',   1, 3600)).toBe(true);
    expect(await hits('contact_form', '')).toBe(0);
  });

  it('budgets are per (bucket, subject), not global', async () => {
    expect(await call('public_lead', 'a', 1, 3600)).toBe(true);
    expect(await call('public_lead', 'b', 1, 3600)).toBe(true);
    expect(await call('signup',      'a', 1, 3600)).toBe(true);
    expect(await call('public_lead', 'a', 1, 3600)).toBe(false);
  });
});

describe('the money-moving surfaces are actually wired up', () => {
  const read = (p: string) => stripComments(readFileSync(resolve(process.cwd(), p), 'utf8'));

  it.each([
    ['accept_plan',     'app/patient/actions.ts'],
    ['pay_saved_card',  'app/patient/actions.ts'],
    ['self_settle',     'app/patient/orders/settle-actions.ts'],
    ['counter_session', 'app/practice/pos/actions.ts'],
    ['credit_check',    'lib/onboarding/actions.ts'],
  ])('%s is spent in %s', (bucket, path) => {
    const src = read(path);
    expect(src).toMatch(new RegExp(`consumeAll\\('${bucket}'`));
    // Keyed on IP AND account, per the module's own rule: either alone is
    // rotatable, and requiring both to be rotated is the point.
    expect(src).toMatch(new RegExp(`RATE_LIMITS\\.${bucket}\\.ip`));
    expect(src).toMatch(new RegExp(`RATE_LIMITS\\.${bucket}\\.account`));
  });

  it('both settle paths share ONE budget', () => {
    // Separate allowances would let a caller alternate between the
    // per-instalment and whole-plan paths for double the throughput, which
    // is exactly what somebody probing a stolen session would do. They fire
    // the same kind of charge at the same provider against the same card.
    const src = read('app/patient/orders/settle-actions.ts');
    expect((src.match(/consumeAll\('self_settle'/g) ?? []).length).toBe(2);
  });

  it('the till limit is keyed on the PRACTICE, not on a user', () => {
    // A busy front desk is several receptionists sharing one unlocked
    // device. The thing worth noticing is the practice's rate, whoever is
    // typing.
    const src = read('app/practice/pos/actions.ts');
    expect(src).toMatch(/\[practiceId,\s+RATE_LIMITS\.counter_session\.account!\]/);
  });

  it('every money bucket is spent AFTER its authorization gate', () => {
    // These are blast-radius limits, not anti-abuse ones: there is no
    // unauthenticated attacker to damp, so the budget is keyed to a caller
    // who has already proved who they are. Spending before the gate would
    // also let an unauthenticated flood exhaust a real patient's allowance.
    const patient = read('app/patient/actions.ts');
    expect(patient.indexOf('requireOnboarded'))
      .toBeLessThan(patient.indexOf("consumeAll('accept_plan'"));
    const pos = read('app/practice/pos/actions.ts');
    expect(pos.indexOf('requireUnlockedDevice(deviceSecret)'))
      .toBeLessThan(pos.indexOf("consumeAll('counter_session'"));
  });

  it('the credit check is limited BEFORE the feature flag is consulted', () => {
    // Otherwise flipping the flag on uncovers a surface that has never been
    // limited, on the day it starts costing money at a bureau.
    const src = read('lib/onboarding/actions.ts');
    const fn  = src.slice(src.indexOf('export async function runCreditCheck'));
    expect(fn.indexOf("consumeAll('credit_check'")).toBeLessThan(fn.indexOf('currentFlags().creditCheck'));
  });
});
