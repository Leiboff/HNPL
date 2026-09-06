// @vitest-environment node
//
// ─── 0139: one verified cell number, one patient account ─────────────────
//
// The three identifiers that should make a second account impossible are
// email, SA ID and cell number. Two of them already were — email at the auth
// layer and on the profiles mirror, SA ID via 0097's blind index. Phone had
// nothing, and production reached fifty accounts on one number (forty-one
// verified, over three months) with nothing able to notice.
//
// Four properties, and the middle two are the ones that would be easy to
// ship broken:
//
//   1. A second patient cannot verify a number another patient has verified.
//   2. It is NOT evadable by writing the number in the other format.
//      Production stores both `+27…` and `0…`, and one of the `0…` rows is
//      verified — a plain equality check would have missed exactly that row.
//   3. It does NOT bypass for service_role. Every phone stamp in this
//      codebase runs on that client, so the usual privileged bypass would
//      exempt all three call sites and leave a trigger guarding nothing.
//   4. Everything legitimate still works: re-verifying your own number,
//      changing to a free number, a practice admin sharing with a patient,
//      an admin clearing a stale row so a recycled number can be re-used.
//
// Runs as real non-superuser roles — pglite's default role bypasses RLS.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0139_unique_verified_phone.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const ALICE   = '0000aaaa-0000-0000-0000-00000000aaaa';
const BOB     = '0000bbbb-0000-0000-0000-00000000bbbb';
const CAROL   = '0000cccc-0000-0000-0000-00000000cccc';
const DENTIST = '0000dddd-0000-0000-0000-00000000dddd';

const NUMBER  = '+27821234567';
const LOCAL   = '0821234567';       // the SAME handset, the other shape
const SPACED  = '+27 82 123 4567';  // and again, as a human would type it
const OTHER   = '+27837654321';

const SCHEMA = `
  create role anon          nologin;
  create role authenticated nologin;
  create role service_role  nologin bypassrls;

  create table _ctx (uid uuid, role text);
  insert into _ctx values (null, 'authenticated');
  create schema if not exists auth;
  create or replace function auth.uid()  returns uuid
    language sql stable as $$ select uid  from _ctx limit 1 $$;
  create or replace function auth.role() returns text
    language sql stable as $$ select role from _ctx limit 1 $$;

  create table profiles (
    id                uuid primary key,
    role              text,
    email             text unique,
    phone             text,
    phone_verified_at timestamptz
  );

  grant usage on schema auth, public to anon, authenticated, service_role;
  grant select, update on _ctx        to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role()
                                      to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public
                                      to anon, authenticated, service_role;

  create or replace function hnpl_write_is_privileged() returns boolean
    language sql stable set search_path = public as $$
      select coalesce(auth.role() = 'service_role', false)
          or coalesce(current_setting('app.privileged_write', true) = 'on', false);
    $$;
`;

let db: PGlite;

/** service_role — what every phone stamp in the app actually holds. */
async function asService<T>(sql: string): Promise<T[]> {
  await db.exec(`update _ctx set uid = null, role = 'service_role';`);
  await db.exec('set role service_role;');
  try {
    return (await db.query(sql)).rows as T[];
  } finally {
    await db.exec('reset role;');
    await db.exec(`update _ctx set role = 'authenticated';`);
  }
}

const seedVerified = (id: string, email: string, phone: string, role = 'patient') =>
  asService(`insert into profiles (id, role, email, phone, phone_verified_at)
             values ('${id}', '${role}', '${email}', '${phone}', now());`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG);
}, 60_000);

afterAll(async () => { await db?.close(); });

// ─────────────────────────────────────────────────────────────────────────

describe('hnpl_normalise_phone_za — it must agree with the TypeScript', () => {
  const norm = async (input: string | null) => {
    const arg = input === null ? 'null' : `'${input}'`;
    const rows = await asService<{ n: string | null }>(
      `select hnpl_normalise_phone_za(${arg}) as n;`);
    return rows[0].n;
  };

  it('canonicalises every shape of the same number to one string', async () => {
    for (const shape of ['+27821234567', '27821234567', '0821234567',
                         '+27 82 123 4567', '082-123-4567', '(082) 123 4567']) {
      expect(await norm(shape)).toBe('+27821234567');
    }
  });

  it('returns null for a landline — it cannot receive the OTP this rests on', async () => {
    expect(await norm('+27114567890')).toBeNull();   // 011 Johannesburg
    expect(await norm('0214567890')).toBeNull();     // 021 Cape Town
  });

  it('returns null rather than guessing at anything malformed', async () => {
    for (const bad of ['', 'not a number', '+2782123456', '+278212345678', '+448212345678']) {
      expect(await norm(bad)).toBeNull();
    }
    expect(await norm(null)).toBeNull();             // STRICT
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('the second account cannot verify the same number', () => {
  beforeAll(async () => { await seedVerified(ALICE, 'alice@x.co', NUMBER); });

  it('refuses on INSERT', async () => {
    await expect(seedVerified(BOB, 'bob@x.co', NUMBER))
      .rejects.toThrow(/already verified on another account/i);
  });

  it('refuses on UPDATE — the path every real call site takes', async () => {
    // app/(auth)/verify-phone/actions.ts writes the number first and stamps
    // phone_verified_at afterwards, so this is the shape that matters.
    await asService(`insert into profiles (id, role, email, phone)
                     values ('${BOB}', 'patient', 'bob@x.co', '${NUMBER}');`);
    await expect(asService(
      `update profiles set phone_verified_at = now() where id = '${BOB}';`))
      .rejects.toThrow(/already verified on another account/i);
  });

  it('is not evadable by writing the number in the other format', async () => {
    // THE assertion. Production stores both `+27…` and `0…` shapes and one
    // of the `0…` rows is verified, so a plain equality check would have
    // let this straight through: same handset, same OTP, second account.
    await expect(asService(
      `update profiles set phone = '${LOCAL}', phone_verified_at = now()
        where id = '${BOB}';`))
      .rejects.toThrow(/already verified on another account/i);
  });

  it('is not evadable with spaces either', async () => {
    await expect(asService(
      `update profiles set phone = '${SPACED}', phone_verified_at = now()
        where id = '${BOB}';`))
      .rejects.toThrow(/already verified on another account/i);
  });

  it('raises unique_violation, so a caller can recognise it structurally', async () => {
    // The app maps this to "phone_in_use" copy. Matching on message text
    // would break the moment somebody rewords the exception.
    try {
      await seedVerified(CAROL, 'carol@x.co', NUMBER);
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('23505');
    }
  });

  it('names no account and no owner in the message', async () => {
    // Whoever is holding the handset may learn the number is spoken for,
    // and nothing else about who has it.
    const message = await seedVerified(CAROL, 'carol2@x.co', NUMBER)
      .then(() => '', (e: Error) => e.message);
    expect(message).not.toContain(ALICE);
    expect(message).not.toContain('alice');
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('service_role does not get a pass', () => {
  it('every assertion above ran as service_role', async () => {
    // Stated as its own test because it is the single easiest thing to get
    // wrong here. Every other guard trigger in this schema opens with
    // `IF hnpl_write_is_privileged() THEN RETURN NEW` — and all three phone
    // stamps in the codebase run on the service-role client, so copying that
    // line would have exempted every caller and left a trigger guarding
    // nothing at all.
    const src = MIG.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const fn  = src.slice(src.indexOf('FUNCTION enforce_unique_verified_phone'));
    expect(fn).not.toMatch(/hnpl_write_is_privileged/);
  });

  it('and the explicit privileged flag does not open it either', async () => {
    await db.exec(`select set_config('app.privileged_write', 'on', false);`);
    try {
      await expect(seedVerified(CAROL, 'carol3@x.co', NUMBER))
        .rejects.toThrow(/already verified on another account/i);
    } finally {
      await db.exec(`select set_config('app.privileged_write', 'off', false);`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('what must keep working', () => {
  it('re-stamping your OWN verified number is fine', async () => {
    // The verify action re-reads and re-writes verified_at; a self-collision
    // here would break the ordinary success path.
    await asService(`update profiles set phone_verified_at = now() where id = '${ALICE}';`);
    const rows = await asService<{ n: number }>(
      `select count(*)::int as n from profiles
        where id = '${ALICE}' and phone_verified_at is not null;`);
    expect(rows[0].n).toBe(1);
  });

  it('a second patient may verify a DIFFERENT number', async () => {
    await asService(`update profiles set phone = '${OTHER}', phone_verified_at = now()
                      where id = '${BOB}';`);
    const rows = await asService<{ phone: string }>(
      `select phone from profiles where id = '${BOB}';`);
    expect(rows[0].phone).toBe(OTHER);
  });

  it('a practice admin may share a number with a patient', async () => {
    // 0097's precedent, deliberately preserved: a solo dentist who is also a
    // customer is one person with two legitimate roles, and refusing that
    // breaks a real signup for no fraud benefit. The lending surface is
    // patients, and that is where this bites.
    await seedVerified(DENTIST, 'dentist@x.co', NUMBER, 'practice_admin');
    const rows = await asService<{ n: number }>(
      `select count(*)::int as n from profiles where phone = '${NUMBER}';`);
    expect(rows[0].n).toBe(2);   // ALICE the patient, and the dentist
  });

  it('an unverified duplicate is allowed — it is not a claim yet', async () => {
    // Typing a number does not assert anything; only the OTP does. Refusing
    // here would also hand anyone a lockout weapon: type a stranger's number
    // into your own account and they can never verify it.
    await asService(`insert into profiles (id, role, email, phone)
                     values ('0000eeee-0000-0000-0000-00000000eeee', 'patient',
                             'eve@x.co', '${NUMBER}');`);
    const rows = await asService<{ n: number }>(
      `select count(*)::int as n from profiles
        where phone = '${NUMBER}' and phone_verified_at is null;`);
    expect(rows[0].n).toBe(1);
  });

  it('clearing a stale row frees the number — the recycled-number remedy', async () => {
    // SA numbers are recycled after prolonged dormancy. An admin clears the
    // dead account's phone_verified_at, and the new owner re-verifies.
    await asService(`update profiles set phone_verified_at = null where id = '${ALICE}';`);
    await asService(`update profiles set phone = '${NUMBER}', phone_verified_at = now()
                      where id = '0000eeee-0000-0000-0000-00000000eeee';`);
    const rows = await asService<{ n: number }>(
      `select count(*)::int as n from profiles
        where phone = '${NUMBER}' and phone_verified_at is not null and role = 'patient';`);
    expect(rows[0].n).toBe(1);
  });

  it('an unrelated profile update is untouched by any of this', async () => {
    // profiles is written constantly — login counts, passkey prompts,
    // onboarding flags. The trigger must not run its lookup on every one.
    await asService(`update profiles set email = 'alice+new@x.co' where id = '${ALICE}';`);
    const rows = await asService<{ email: string }>(
      `select email from profiles where id = '${ALICE}';`);
    expect(rows[0].email).toBe('alice+new@x.co');
  });

  it('a malformed number is let through rather than failing a signup', async () => {
    // A phone the normaliser cannot canonicalise is a data-quality problem,
    // not a fraud signal.
    await asService(`insert into profiles (id, role, email, phone, phone_verified_at)
                     values ('0000ffff-0000-0000-0000-00000000ffff', 'patient',
                             'f@x.co', 'not a number', now());`);
    const rows = await asService<{ n: number }>(
      `select count(*)::int as n from profiles where email = 'f@x.co';`);
    expect(rows[0].n).toBe(1);
  });
});
