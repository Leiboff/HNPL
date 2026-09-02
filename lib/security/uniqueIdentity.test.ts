import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ─── Three identifiers that must never be shareable ───────────────────────
//
// Email, SA ID and cell number. Each of them, in this product, identifies
// exactly one person — and this file exists because that was true of only
// two of them for most of the platform's life, and nobody noticed.
//
// The one with no constraint was phone. Production reached SIX duplicated
// numbers, one of them on FIFTY accounts with forty-one verified, over three
// months. Nothing in the system could have flagged it; there was no rule to
// break.
//
// So the constraint is pinned here, in source, rather than trusted to stay.
// A migration that drops one of these three fails this test — which is the
// only mechanism that would have caught the original absence, since "a
// constraint nobody wrote" leaves no evidence anywhere else.
//
// ─── WHY SOURCE ASSERTIONS AND NOT A LIVE CHECK ───────────────────────────
//
// A live check needs the service-role key, which is why the drift cron
// (app/api/cron/rls-drift) exists and why it runs where the key already is.
// This half runs in CI on every push, with no database and no credential,
// and answers a different question: what does a FRESH environment get. Both
// halves are needed — R3-08 was exactly a case where they differed for
// months and only production was correct.

const ROOT = resolve(process.cwd());
const DIR  = resolve(ROOT, 'supabase/migrations');

const SQL = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(join(DIR, f), 'utf8').replace(/\r\n/g, '\n') }));

/** Every migration's SQL, comments stripped — several assertions look for
 *  the ABSENCE of a statement, and headers discuss the statements at length. */
const CODE = SQL
  .map((m) => m.sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'))
  .join('\n');

describe('email is unique, and stays unique', () => {
  it('profiles.email carries a unique constraint', () => {
    // Belt to the auth layer's braces (auth.users.users_email_partial_key,
    // which this repo does not own and cannot pin). The mirror is ours.
    expect(CODE).toMatch(/email\s+TEXT[^,\n]*UNIQUE|UNIQUE\s*\(\s*email\s*\)|UNIQUE INDEX[^;]*\(\s*email\s*\)/i);
  });

  it('nothing ever drops it', () => {
    expect(CODE).not.toMatch(/DROP\s+(CONSTRAINT|INDEX)[^;]*profiles_email_key/i);
  });
});

describe('SA ID is unique per patient, and stays unique', () => {
  it('0097 creates the blind-index unique constraint', () => {
    // On sa_id_lookup_hash, not sa_id_number: the ID itself is AES-256-GCM
    // with a random IV, so two rows holding the same ID do not compare equal
    // and a UNIQUE on that column would accept every duplicate. 0096's
    // header spells this out.
    const m = SQL.find((f) => f.file.startsWith('0097'));
    expect(m).toBeDefined();
    expect(m!.sql).toMatch(/CREATE\s+UNIQUE\s+INDEX[\s\S]*sa_id_lookup_hash/i);
  });

  it('it is scoped to patients on purpose, not by accident', () => {
    const m = SQL.find((f) => f.file.startsWith('0097'))!;
    // A doctor who is also a patient is two legitimate rows. Pinned so that
    // a future reader does not "tighten" it and break that signup.
    expect(m.sql).toMatch(/WHERE[\s\S]{0,120}role\s*=\s*'patient'/i);
  });

  it('nothing ever drops it', () => {
    expect(CODE).not.toMatch(/DROP\s+INDEX[^;]*sa_id_lookup_hash/i);
  });
});

describe('a verified cell number is unique per patient', () => {
  const m = () => SQL.find((f) => f.file.startsWith('0139'))!;

  it('0139 exists and guards profiles', () => {
    expect(m()).toBeDefined();
    expect(m().sql).toMatch(/CREATE TRIGGER trg_enforce_unique_verified_phone/);
    expect(m().sql).toMatch(/BEFORE INSERT OR UPDATE ON profiles/);
  });

  it('it compares the NORMALISED number, not the raw column', () => {
    // Production stores both `+27…` and `0…`, and one of the `0…` rows is
    // verified. Raw equality is evadable by typing the other format: same
    // handset, same OTP, second account.
    const fn = m().sql.slice(m().sql.indexOf('FUNCTION enforce_unique_verified_phone'));
    expect(fn).toMatch(/hnpl_normalise_phone_za/);
    expect(fn).not.toMatch(/p\.phone\s*=\s*NEW\.phone/);
  });

  it('it does NOT bypass for a privileged writer', () => {
    // The single easiest thing to get wrong. Every other guard trigger in
    // this schema opens with `IF hnpl_write_is_privileged() THEN RETURN NEW`
    // because those enforce WHO may write a column. This one is a uniqueness
    // invariant, and all three phone stamps in the codebase run on the
    // service-role client — so that line would exempt every caller.
    const code = m().sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const fn   = code.slice(code.indexOf('FUNCTION enforce_unique_verified_phone'));
    expect(fn).not.toMatch(/hnpl_write_is_privileged/);
  });

  it('it takes a lock, so a concurrent pair cannot both pass', () => {
    // The one thing a trigger does not get for free and a unique index does.
    // Reachable on purpose here: two signups raced on one handset is a
    // deliberate act, not a coincidence.
    expect(m().sql).toMatch(/pg_advisory_xact_lock/);
  });

  it('nothing ever drops the trigger', () => {
    const after0139 = SQL.filter((f) => f.file > '0139_z')
      .map((f) => f.sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'))
      .join('\n');
    expect(after0139).not.toMatch(/DROP TRIGGER[^;]*trg_enforce_unique_verified_phone/i);
  });
});

describe('the rules layer agrees with the schema', () => {
  const RULES = readFileSync(resolve(ROOT, 'lib/security/identitySignals.ts'), 'utf8');
  // Comment-free, so assertions about what the code does are not satisfied
  // by prose describing it. `case 'phone':` is the last arm of the switch,
  // so it runs to the end of thresholdsFor.
  const CODE   = RULES.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const BRANCH = CODE.slice(CODE.indexOf("case 'phone':"), CODE.indexOf('export type LinkCount'));

  it('the branch was actually found', () => {
    // Without this the two assertions below pass on an empty string.
    expect(CODE).toContain("case 'phone':");
    expect(BRANCH.length).toBeGreaterThan(20);
    expect(BRANCH).toContain('return');
  });

  it('a shared verified phone blocks on the first other account', () => {
    // 0139 stops it at verification time. This is the backstop for an
    // account verified BEFORE 0139 existed that only reaches the credit step
    // now — production has forty-one of those.
    expect(BRANCH).toMatch(/blockAt:\s*1\b/);
    expect(BRANCH).toMatch(/flagAt:\s*1\b/);
  });

  it('and no env var can loosen it', () => {
    // Every other threshold is env-tunable so the first weeks of real
    // traffic can retune it without a deploy. This one is not a dial: a
    // phone that does not block permits the duplicate account the whole
    // mechanism exists to stop.
    expect(BRANCH).not.toMatch(/envInt/);
    expect(BRANCH).not.toMatch(/process\.env/);
  });
});
