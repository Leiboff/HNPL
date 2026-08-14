// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// ─── Real-database test: claiming an unbound counter-session plan ─────────
//
// The guarantees this has to hold are ownership guarantees, and every one of
// them is enforced by a WHERE clause, so they are tested against a real
// Postgres rather than against a recording of which builder methods were
// called. The adversarial cases in particular — "a signed-in patient must
// never reach someone else's plan" — are only meaningful if the UPDATE really
// runs.
//
// A throwaway encryption key is generated per run and injected before the
// module under test is imported, because getKey() reads process.env lazily.

const TEST_KEY = randomBytes(32).toString('base64');
process.env.SA_ID_ENCRYPTION_KEY = TEST_KEY;

const PATIENT_SA_ID  = '9001015800086';
const SOMEONE_ELSE   = '8202025800085';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let encryptId: (s: string) => string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let claimUnboundSessionPlan: any;

beforeAll(async () => {
  ({ encryptId } = await import('@/lib/idEncryption'));
  ({ claimUnboundSessionPlan } = await import('./claimSessionPlan'));
});

const SCHEMA = `
  create table profiles (
    id           uuid primary key,
    sa_id_number text
  );
  create table applications (
    id         uuid primary key default gen_random_uuid(),
    patient_id uuid
  );
  create table plans (
    id             uuid primary key default gen_random_uuid(),
    application_id uuid,
    patient_id     uuid,
    status         text not null default 'pending_acceptance'
  );
`;

const MODELLED = new Set(['profiles', 'plans', 'applications']);

/** Minimal PostgREST-over-pglite shim: select/update/eq/is/maybeSingle/select. */
function shim(db: PGlite) {
  return {
    from(table: string) {
      if (!MODELLED.has(table)) throw new Error(`[shim] unmodelled table "${table}"`);
      let mode: 'select' | 'update' = 'select';
      let cols = '*';
      let patch: Record<string, unknown> = {};
      const eq: Array<[string, unknown]> = [];
      const isNull: string[] = [];

      async function run(returning: string) {
        const params: unknown[] = [];
        const where: string[] = [];
        let sql: string;
        if (mode === 'update') {
          const sets = Object.entries(patch).map(([c, v]) => {
            params.push(v);
            return `${c} = $${params.length}`;
          });
          sql = `update ${table} set ${sets.join(', ')}`;
        } else {
          sql = `select ${cols} from ${table}`;
        }
        for (const [c, v] of eq) { params.push(v); where.push(`${c} = $${params.length}`); }
        for (const c of isNull) where.push(`${c} is null`);
        if (where.length) sql += ` where ${where.join(' and ')}`;
        if (mode === 'update') sql += ` returning ${returning}`;
        try {
          const res = await db.query(sql, params);
          return { data: res.rows as Array<Record<string, unknown>>, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      }

      const builder = {
        select(c: string) {
          if (mode === 'update') return run(c);           // .update().select()
          cols = c;
          return builder;
        },
        update(next: Record<string, unknown>) { mode = 'update'; patch = next; return builder; },
        eq(c: string, v: unknown) { eq.push([c, v]); return builder; },
        is(c: string, v: unknown) {
          if (v !== null) throw new Error('[shim] only .is(col, null) is modelled');
          isNull.push(c);
          return builder;
        },
        async maybeSingle() {
          const r = await run('*');
          return { data: (r.data ?? [])[0] ?? null, error: r.error };
        },
        // An update with no .select() still has to execute.
        then(onFulfilled: (v: unknown) => unknown) { return run('*').then(onFulfilled); },
      };
      return builder;
    },
  };
}

let db: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svc: any;
let userId: string;
let otherUserId: string;

async function seedProfile(id: string, saIdPlain: string | null) {
  await db.query(`insert into profiles (id, sa_id_number) values ($1, $2)`, [
    id, saIdPlain === null ? null : encryptId(saIdPlain),
  ]);
}

async function seedPlan(patientId: string | null = null): Promise<{ planId: string; applicationId: string }> {
  const app = await db.query<{ id: string }>(
    `insert into applications (patient_id) values ($1) returning id`, [patientId],
  );
  const applicationId = app.rows[0].id;
  const plan = await db.query<{ id: string }>(
    `insert into plans (application_id, patient_id) values ($1, $2) returning id`,
    [applicationId, patientId],
  );
  return { planId: plan.rows[0].id, applicationId };
}

async function ownerOf(planId: string): Promise<string | null> {
  const r = await db.query<{ patient_id: string | null }>(
    `select patient_id from plans where id = $1`, [planId],
  );
  return r.rows[0].patient_id;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  svc = shim(db);
  userId      = randomUUID();
  otherUserId = randomUUID();
});

describe('the returning patient this exists for', () => {
  it('binds the plan when the profile SA ID matches the one captured at the till', async () => {
    await seedProfile(userId, PATIENT_SA_ID);
    const { planId, applicationId } = await seedPlan(null);

    const out = await claimUnboundSessionPlan({
      svc, planId, applicationId, userId,
      sessionSaIdEncrypted: encryptId(PATIENT_SA_ID),
    });

    expect(out).toEqual({ claimed: true, reason: 'claimed' });
    expect(await ownerOf(planId)).toBe(userId);
  });

  it('matches on the DECRYPTED value — two encryptions of one ID never look alike', async () => {
    // AES-256-GCM with a random IV: the ciphertexts differ every time. A
    // string comparison of the stored values would reject every real patient.
    const a = encryptId(PATIENT_SA_ID);
    const b = encryptId(PATIENT_SA_ID);
    expect(a).not.toBe(b);

    await seedProfile(userId, PATIENT_SA_ID);
    const { planId, applicationId } = await seedPlan(null);
    const out = await claimUnboundSessionPlan({ svc, planId, applicationId, userId, sessionSaIdEncrypted: b });
    expect(out.claimed).toBe(true);
  });

  it('binds the application alongside the plan, as initiateCheckout does', async () => {
    await seedProfile(userId, PATIENT_SA_ID);
    const { planId, applicationId } = await seedPlan(null);

    await claimUnboundSessionPlan({ svc, planId, applicationId, userId, sessionSaIdEncrypted: encryptId(PATIENT_SA_ID) });

    const r = await db.query<{ patient_id: string | null }>(
      `select patient_id from applications where id = $1`, [applicationId],
    );
    expect(r.rows[0].patient_id).toBe(userId);
  });

  it('is idempotent — a refresh re-runs it and the owner does not change', async () => {
    await seedProfile(userId, PATIENT_SA_ID);
    const { planId, applicationId } = await seedPlan(null);
    const args = { svc, planId, applicationId, userId, sessionSaIdEncrypted: encryptId(PATIENT_SA_ID) };

    expect((await claimUnboundSessionPlan(args)).reason).toBe('claimed');
    // Second pass finds it already bound to THEM — still a pass, not a bounce.
    expect(await claimUnboundSessionPlan(args)).toEqual({ claimed: true, reason: 'raced_same_user' });
    expect(await ownerOf(planId)).toBe(userId);
  });
});

describe('adversarial: nobody reaches a plan that is not theirs', () => {
  it('refuses when the signed-in patient\'s SA ID is not the billed one', async () => {
    // The person standing at the counter is logged into their own account but
    // the practice raised this bill against somebody else's ID.
    await seedProfile(userId, SOMEONE_ELSE);
    const { planId, applicationId } = await seedPlan(null);

    const out = await claimUnboundSessionPlan({
      svc, planId, applicationId, userId,
      sessionSaIdEncrypted: encryptId(PATIENT_SA_ID),
    });

    expect(out).toEqual({ claimed: false, reason: 'id_mismatch' });
    expect(await ownerOf(planId)).toBeNull();
  });

  it('refuses when the account has no SA ID at all — a login is not a proof', async () => {
    await seedProfile(userId, null);
    const { planId, applicationId } = await seedPlan(null);

    const out = await claimUnboundSessionPlan({
      svc, planId, applicationId, userId, sessionSaIdEncrypted: encryptId(PATIENT_SA_ID),
    });

    expect(out).toEqual({ claimed: false, reason: 'no_profile_id' });
    expect(await ownerOf(planId)).toBeNull();
  });

  it('refuses when there is no profile row at all', async () => {
    const { planId, applicationId } = await seedPlan(null);
    const out = await claimUnboundSessionPlan({
      svc, planId, applicationId, userId, sessionSaIdEncrypted: encryptId(PATIENT_SA_ID),
    });
    expect(out).toEqual({ claimed: false, reason: 'no_profile_id' });
  });

  it('NEVER moves a plan that already belongs to somebody else — even on an ID match', async () => {
    // The sharpest case: two accounts carrying the same SA ID (a duplicate
    // registration). The identity test passes and the plan STILL must not
    // move, because `.is('patient_id', null)` is the real boundary.
    await seedProfile(userId, PATIENT_SA_ID);
    await seedProfile(otherUserId, PATIENT_SA_ID);
    const { planId, applicationId } = await seedPlan(otherUserId);

    const out = await claimUnboundSessionPlan({
      svc, planId, applicationId, userId, sessionSaIdEncrypted: encryptId(PATIENT_SA_ID),
    });

    expect(out).toEqual({ claimed: false, reason: 'already_bound' });
    expect(await ownerOf(planId)).toBe(otherUserId);
  });

  it('fails CLOSED when the stored identity cannot be decrypted', async () => {
    await db.query(`insert into profiles (id, sa_id_number) values ($1, $2)`, [userId, 'v1:not-a-real-ciphertext']);
    const { planId, applicationId } = await seedPlan(null);

    const out = await claimUnboundSessionPlan({
      svc, planId, applicationId, userId, sessionSaIdEncrypted: encryptId(PATIENT_SA_ID),
    });

    expect(out).toEqual({ claimed: false, reason: 'decrypt_failed' });
    expect(await ownerOf(planId)).toBeNull();
  });

  it('fails CLOSED when the SESSION value cannot be decrypted', async () => {
    await seedProfile(userId, PATIENT_SA_ID);
    const { planId, applicationId } = await seedPlan(null);

    const out = await claimUnboundSessionPlan({
      svc, planId, applicationId, userId, sessionSaIdEncrypted: 'v1:garbage',
    });

    expect(out).toEqual({ claimed: false, reason: 'decrypt_failed' });
    expect(await ownerOf(planId)).toBeNull();
  });

  it('leaves the application untouched whenever the plan is refused', async () => {
    await seedProfile(userId, SOMEONE_ELSE);
    const { planId, applicationId } = await seedPlan(null);

    await claimUnboundSessionPlan({
      svc, planId, applicationId, userId, sessionSaIdEncrypted: encryptId(PATIENT_SA_ID),
    });

    const r = await db.query<{ patient_id: string | null }>(
      `select patient_id from applications where id = $1`, [applicationId],
    );
    expect(r.rows[0].patient_id).toBeNull();
    expect(await ownerOf(planId)).toBeNull();
  });
});
