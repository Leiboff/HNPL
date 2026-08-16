import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'crypto';
import { stripComments } from '@/lib/testing/stripComments';
import { encryptId, decryptId, hashIdForLookup } from '@/lib/idEncryption';
import { validateSaId } from '@/lib/validation/saId';

// ─── Encrypting the legacy plaintext sa_id_number rows ────────────────────
//
// Migration 0033 made the app encrypt before writing, but nothing revisited
// the rows written before it. Phase 1's audit found 18; the duplicate
// cleanup incidentally cleared 12, leaving 6 SA ID numbers stored in the
// clear.
//
// Two things have to hold, and only one of them is about the script:
//
//   1. The DETECTION RULE ("does not start with v1:") must be exact in both
//      directions. A false negative leaves a plaintext ID behind; a false
//      positive skips a row forever. Both directions are provable from the
//      real encryptId and the real validateSaId, so they are tested rather
//      than asserted in a comment.
//   2. sa_id_lookup_hash must survive untouched. It is HMAC(key, PLAINTEXT
//      ID) — derived from the ID, never from the column's stored form — so
//      encrypting the column cannot invalidate it. That is the claim 0097's
//      unique index rests on, so it is exercised end to end below.
//
// The rest pins the script's safety properties: writes only one column,
// restore file before the first write, idempotent, and a verification pass
// that round-trips from the database rather than trusting the prefix.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

const SCRIPT = read('scripts/encrypt-legacy-sa-ids.ts');

const ENV_KEY        = 'SA_ID_ENCRYPTION_KEY';
const ENV_LOOKUP_KEY = 'SA_ID_LOOKUP_HMAC_KEY';

beforeAll(() => {
  process.env[ENV_KEY]        = randomBytes(32).toString('base64');
  process.env[ENV_LOOKUP_KEY] = randomBytes(32).toString('base64');
});

const isCiphertext = (v: string) => v.startsWith('v1:');

describe('the detection rule is exact in both directions', () => {
  it('every value encryptId produces is detected as already-encrypted', () => {
    // Not a single sample: the IV is random, so the base64 body differs
    // every call and only the prefix is stable. That IS the rule.
    for (let i = 0; i < 50; i += 1) {
      expect(isCiphertext(encryptId('900101580008' + (i % 10)))).toBe(true);
    }
  });

  it('a valid SA ID can never be mistaken for ciphertext', () => {
    // Not a claim about one sample: validateSaId requires ^\d{13}$, so no
    // value it accepts can begin with a letter at all. The two sets are
    // disjoint by construction, which is what makes the rule safe to run
    // unattended over a whole table.
    // Luhn-valid samples. Note these are NOT idEncryption.test.ts's
    // '9001015800086', which fails the checksum — that file only ever uses
    // it as an arbitrary 13-digit string and never validates it.
    for (const id of ['9001015800088', '8506155001082', '0002295000083']) {
      expect(validateSaId(id).valid).toBe(true);
      expect(isCiphertext(id)).toBe(false);
    }

    for (const notAnId of ['v1:', 'v1:abc', 'v100000000000', 'v901015800086']) {
      expect(validateSaId(notAnId).valid).toBe(false);
      expect(isCiphertext(notAnId)).toBe(notAnId.startsWith('v1:'));
    }
  });

  it('decryptId refuses any other version, so no third storage format was ever possible', () => {
    // The reason "not v1:" is equivalent to "plaintext": nothing else has
    // ever been storable. If a v2 is introduced, this fails and the script
    // has to be revisited before it runs again.
    expect(() => decryptId('v2:a:b:c')).toThrow(/Unknown encryption version/i);
    expect(() => decryptId('v0:a:b:c')).toThrow(/Unknown encryption version/i);
  });
});

describe('encrypting the column does not invalidate the blind index', () => {
  it('the hash of the plaintext is what the row already holds, and stays valid after', () => {
    const id     = '9001015800086';
    const stored = hashIdForLookup(id);           // what the Phase 1 backfill wrote
    const cipher = encryptId(id);                 // what this script would store

    expect(hashIdForLookup(decryptId(cipher))).toBe(stored);
  });

  it('the hash is a function of the ID, not of the ciphertext', () => {
    // Two encryptions of one ID differ, and neither changes the hash. If
    // this were false, encrypting would silently break 0097's uniqueness.
    const id = '9001015800086';
    const a  = encryptId(id);
    const b  = encryptId(id);
    expect(a).not.toBe(b);
    expect(hashIdForLookup(decryptId(a))).toBe(hashIdForLookup(decryptId(b)));
  });

  it('a whitespace-carrying legacy value round-trips byte-for-byte', () => {
    // The script encrypts EXACTLY what is stored rather than a trimmed
    // version, so the restore file's value is recoverable verbatim.
    const stored = ' 9001015800086\n';
    expect(decryptId(encryptId(stored))).toBe(stored);
  });
});

describe('the script writes one column and nothing else', () => {
  it('every update sets sa_id_number alone', () => {
    const updates = [...SCRIPT.matchAll(/\.update\(([^)]*)\)/g)].map((m) => m[1]);
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u).toMatch(/^\{ sa_id_number: cipher \}$/);
  });

  it('never writes the hash column — FORBIDDEN by the task', () => {
    expect(SCRIPT).not.toMatch(/sa_id_lookup_hash:\s*(hash|hashIdForLookup|null)/);
  });

  it('never deletes, inserts, or changes a role', () => {
    expect(SCRIPT).not.toMatch(/\.delete\(/);
    expect(SCRIPT).not.toMatch(/\.insert\(/);
    expect(SCRIPT).not.toMatch(/\.upsert\(/);
    expect(SCRIPT).not.toMatch(/auth\.admin\.deleteUser/);
    expect(SCRIPT).not.toMatch(/role:\s*'/);
  });

  it('does not touch the 0097 index or any migration', () => {
    expect(SCRIPT).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
    expect(SCRIPT).not.toMatch(/DROP INDEX/i);
    expect(SCRIPT).not.toMatch(/profiles_sa_id_lookup_hash_patient_uniq/);
  });
});

describe('it refuses to start on a key it cannot use', () => {
  it('checks the key ROUND-TRIPS, not merely that it encrypts', () => {
    // A key that encrypts but cannot decrypt would destroy every ID it
    // touched, and the prefix check would report success.
    expect(SCRIPT).toMatch(/decryptId\(encryptId\(probe\)\) !== probe/);
  });

  it('the key check happens before the client is even built', () => {
    const guard  = SCRIPT.indexOf('decryptId(encryptId(probe))');
    const client = SCRIPT.indexOf('createClient(');
    expect(guard).toBeGreaterThan(0);
    expect(client).toBeGreaterThan(guard);
  });

  it('exits rather than continuing when SA_ID_ENCRYPTION_KEY is absent', () => {
    expect(SCRIPT).toMatch(/if \(!process\.env\.SA_ID_ENCRYPTION_KEY\)[\s\S]{0,160}process\.exit\(1\)/);
  });
});

describe('dry run, restore file, idempotence', () => {
  it('supports --dry-run and returns before any write', () => {
    expect(SCRIPT).toMatch(/const DRY = process\.argv\.includes\('--dry-run'\)/);
    const dryReturn = SCRIPT.indexOf('dry run — nothing written');
    const restore   = SCRIPT.indexOf('writeFileSync(OUT');
    expect(dryReturn).toBeGreaterThan(0);
    expect(restore).toBeGreaterThan(dryReturn);
  });

  it('writes the restore file BEFORE the first update', () => {
    const restore = SCRIPT.indexOf('writeFileSync(OUT');
    const write   = SCRIPT.indexOf('.update({ sa_id_number: cipher })');
    expect(restore).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(restore);
  });

  it('the restore file carries the plaintext AND the hash, so a bad run is fully reversible', () => {
    const block = SCRIPT.slice(SCRIPT.indexOf('const restore = plain.map'), SCRIPT.indexOf('writeFileSync(OUT'));
    expect(block).toMatch(/sa_id_number:\s*p\.sa_id_number/);
    expect(block).toMatch(/sa_id_lookup_hash:\s*p\.sa_id_lookup_hash/);
  });

  it('is idempotent — an already-encrypted row is partitioned out, never re-encrypted', () => {
    // Re-encrypting would still round-trip, but it would rewrite rows the
    // script has no business touching and grow the restore file with values
    // that are not plaintext.
    expect(SCRIPT).toMatch(/const already = rows\.filter\(\(r\) => \(r\.sa_id_number \?\? ''\)\.startsWith\('v1:'\)\)/);
    expect(SCRIPT).toMatch(/const plain\s+= rows\.filter\(\(r\) => !\(r\.sa_id_number \?\? ''\)\.startsWith\('v1:'\)\)/);
    expect(SCRIPT).toMatch(/every SA ID on file is already encrypted/);
  });

  it('round-trips each ciphertext BEFORE storing it', () => {
    const loop = SCRIPT.slice(SCRIPT.indexOf('for (const p of plain) {\n    const original'));
    const check = loop.indexOf('decryptId(cipher) !== original');
    const write = loop.indexOf('.update({ sa_id_number: cipher })');
    expect(check).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(check);
    expect(loop).toMatch(/refusing to write/);
  });
});

describe('the verification pass proves recoverability, not just the prefix', () => {
  it('re-reads from the database and decrypts back to the restore file value', () => {
    const verify = SCRIPT.slice(SCRIPT.indexOf('const after = await fetchAll()'));
    expect(verify).toMatch(/if \(back !== r\.sa_id_number\) roundTripFailures \+= 1/);
  });

  it('fails if any hash changed — the column it promised not to write', () => {
    const verify = SCRIPT.slice(SCRIPT.indexOf('const after = await fetchAll()'));
    expect(verify).toMatch(/now\.sa_id_lookup_hash !== r\.sa_id_lookup_hash/);
    expect(verify).toMatch(/sa_id_lookup_hash CHANGED/);
  });

  it('exits non-zero unless zero plaintext remains AND every row round-trips', () => {
    expect(SCRIPT).toMatch(/if \(stillPlain\.length > 0 \|\| roundTripFailures > 0\) \{[\s\S]{0,160}process\.exit\(1\)/);
  });

  it('stops before writing when a row\'s hash does not match its plaintext', () => {
    // Encrypting would not CAUSE that mismatch, but it would hide it: the
    // plaintext is currently the only way to see it.
    const stop  = SCRIPT.indexOf('if (hashMismatch)');
    const write = SCRIPT.indexOf('.update({ sa_id_number: cipher })');
    expect(stop).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(stop);
    expect(SCRIPT).toMatch(/STOP — \$\{hashMismatch\}/);
  });
});

describe('it prints no SA ID in the clear', () => {
  it('masks every ID it reports', () => {
    expect(SCRIPT).toMatch(/maskId\(id\)/);
    const logs = [...SCRIPT.matchAll(/console\.(log|error)\(([^\n]*)/g)].map((m) => m[2]);
    for (const line of logs) {
      expect(line).not.toMatch(/\$\{(id|stored|original|plain\[)/);
      expect(line).not.toMatch(/sa_id_number\}/);
    }
  });
});
