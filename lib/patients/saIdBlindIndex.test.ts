import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── One SA ID = one account, Phase 1: the blind index ────────────────────
//
// profiles.sa_id_number is AES-256-GCM with a fresh random IV per call, so
// two rows holding the same SA ID hold two unrelated ciphertexts and
// Postgres cannot tell they match. UNIQUE (sa_id_number) would accept every
// duplicate. Uniqueness has to be enforced on a deterministic derived value
// — profiles.sa_id_lookup_hash, an HMAC-SHA256 blind index.
//
// This file pins the Phase 1 BOUNDARY as much as the mechanism: the column
// lands, the write paths populate it, and NOTHING is made unique yet,
// because uniqueness cannot be applied until a human has decided what
// happens to the duplicates the backfill reveals.
//
// Comments are stripped before matching — the migration's own prose
// discusses the UNIQUE constraint it deliberately does not create.

const ROOT = resolve(process.cwd());
const read    = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));
const readSql = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'), { sql: true });

const MIG_DIR = resolve(ROOT, 'supabase/migrations');
const MIG_NAME = '0096_sa_id_lookup_hash.sql';

/**
 * Executable SQL only: comments AND single-quoted string literals removed.
 *
 * The COMMENT ON COLUMN body deliberately explains that sa_id_number can
 * never be made UNIQUE and that this migration does not add uniqueness —
 * so a bare /UNIQUE/ search over the file finds the documentation and
 * concludes the opposite of the truth. What matters is the DDL.
 */
const ddl = (src: string) => stripComments(src, { sql: true }).replace(/'[^']*'/g, "''");

const UNIQ_NAME = '0097_sa_id_lookup_hash_unique.sql';

const MIG      = readSql(`supabase/migrations/${MIG_NAME}`);
const MIG_DDL  = ddl(readFileSync(resolve(ROOT, `supabase/migrations/${MIG_NAME}`), 'utf8'));
const UNIQ_SQL = readSql(`supabase/migrations/${UNIQ_NAME}`);
const UNIQ_DDL = ddl(readFileSync(resolve(ROOT, `supabase/migrations/${UNIQ_NAME}`), 'utf8'));
const SALES    = read('app/admin/sales-team/actions.ts');
const STRIP    = read('scripts/strip-duplicate-sa-ids.ts');
const ENCRYPT  = read('lib/idEncryption.ts');
const CHECKOUT = read('app/checkout/[token]/actions.ts');
// The organic-signup ID-capture path moved from saveIdAndSalaryDay (manual
// entry, lib/onboarding/actions.ts) to the Didit webhook's handleApproved
// (app/api/verification/didit/webhook/route.ts) — same rules, same
// functions, different trigger. See supabase/migrations/
// 0102_didit_identity_verification.sql for the column-level note.
const ONBOARD  = read('app/api/verification/didit/webhook/route.ts');
const BACKFILL = read('scripts/backfill-sa-id-lookup-hash.ts');
const AUDIT    = read('scripts/audit-sa-id-duplicates.ts');

describe('the migration', () => {
  it('is numbered 0096 — 0085, the number the reverted original used, is taken', () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
    expect(files).toContain(MIG_NAME);
    // The CLI keys the version off the leading digits, so two files at one
    // version are ambiguous. 0085 is checkout_sessions now.
    const at85 = files.filter((f) => f.startsWith('0085'));
    expect(at85).toEqual(['0085_checkout_sessions.sql']);
    const at96 = files.filter((f) => f.startsWith('0096'));
    expect(at96).toEqual([MIG_NAME]);
  });

  it('adds the column NULLABLE — a legacy row with no hash must not block the migration', () => {
    expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS sa_id_lookup_hash TEXT;/);
    expect(MIG).not.toMatch(/sa_id_lookup_hash TEXT NOT NULL/);
    expect(MIG).not.toMatch(/SET NOT NULL/);
  });

  it('indexes it partially, so the many NULL rows cost nothing', () => {
    expect(MIG).toMatch(/CREATE INDEX IF NOT EXISTS profiles_sa_id_lookup_hash_idx/);
    expect(MIG).toMatch(/WHERE sa_id_lookup_hash IS NOT NULL/);
  });

  it('does NOT make anything unique — that is Phase 2, after the cleanup decision', () => {
    expect(MIG_DDL).not.toMatch(/UNIQUE/i);
    expect(MIG_DDL).not.toMatch(/ADD CONSTRAINT/i);
  });

  it('leaves the AES encryption of sa_id_number completely alone', () => {
    // FORBIDDEN in the task: don't change the encryption of sa_id_number.
    expect(MIG).not.toMatch(/ALTER COLUMN sa_id_number/i);
    expect(MIG).not.toMatch(/DROP COLUMN/i);
    expect(MIG).not.toMatch(/UPDATE profiles/i);
    expect(MIG).not.toMatch(/pgcrypto|pgp_sym|encrypt\(/i);
  });

  it('adds no RLS surface', () => {
    expect(MIG).not.toMatch(/CREATE POLICY/i);
    expect(MIG).not.toMatch(/DROP POLICY/i);
    expect(MIG).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(MIG).not.toMatch(/GRANT/i);
  });

  it('documents the column, so the next reader does not mistake it for a plaintext ID', () => {
    expect(MIG).toMatch(/COMMENT ON COLUMN profiles\.sa_id_lookup_hash/);
  });
});

describe('hashIdForLookup — key separation is structural, not a convention', () => {
  it('reads its own env var, distinct from the AES key', () => {
    expect(ENCRYPT).toMatch(/const KEY_ENV = 'SA_ID_ENCRYPTION_KEY';/);
    expect(ENCRYPT).toMatch(/const LOOKUP_KEY_ENV = 'SA_ID_LOOKUP_HMAC_KEY';/);
    expect(ENCRYPT).toMatch(/function getLookupKey\(\)[\s\S]{0,80}readKey\(LOOKUP_KEY_ENV\)/);
  });

  it('hashes with getLookupKey, never getKey', () => {
    const fn = ENCRYPT.slice(ENCRYPT.indexOf('export function hashIdForLookup'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/getLookupKey\(\)/);
    expect(body).not.toMatch(/getKey\(\)/);
  });

  it('is an HMAC, not a bare digest — an unkeyed hash of a 13-digit ID is brute-forceable', () => {
    const fn = ENCRYPT.slice(ENCRYPT.indexOf('export function hashIdForLookup'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/createHmac\('sha256', key\)/);
    expect(body).not.toMatch(/createHash\(/);
  });

  it('both keys still go through the SAME 32-byte validation', () => {
    expect(ENCRYPT).toMatch(/function readKey\(envName: string\)/);
    expect(ENCRYPT).toMatch(/key\.byteLength !== 32/);
    expect(ENCRYPT).toMatch(/function getKey\(\)[\s\S]{0,80}readKey\(KEY_ENV\)/);
  });
});

describe('the write paths populate it — otherwise the column rots from day one', () => {
  it('the anonymous/till checkout writes the hash beside the ciphertext', () => {
    expect(CHECKOUT).toMatch(/import \{[^}]*\bhashIdForLookup\b[^}]*\} from '@\/lib\/idEncryption'/);
    expect(CHECKOUT).toMatch(/saIdLookupHash = hashIdForLookup\(trimmedSaId\)/);
    expect(CHECKOUT).toMatch(/sa_id_lookup_hash:\s*saIdLookupHash,/);
  });

  it('the organic onboarding identity step writes the hash beside the ciphertext', () => {
    expect(ONBOARD).toMatch(/import \{[^}]*\bhashIdForLookup\b[^}]*\} from '@\/lib\/idEncryption'/);
    expect(ONBOARD).toMatch(/lookupHash = hashIdForLookup\(cleanedId\)/);
    expect(ONBOARD).toMatch(/sa_id_lookup_hash:\s*lookupHash,/);
  });

  it('BOTH derive the hash inside the same try as encryptId — fail closed together', () => {
    // A hash skipped on error is a row that escapes the uniqueness
    // constraint. Sharing encryptId's catch means a key problem refuses the
    // write rather than writing a half-populated row.
    for (const src of [CHECKOUT, ONBOARD]) {
      const enc  = src.indexOf('encryptId(');
      const hash = src.indexOf('hashIdForLookup(', enc);
      const close = src.indexOf('} catch', enc);
      expect(hash).toBeGreaterThan(enc);
      expect(close).toBeGreaterThan(hash);
    }
  });

  it('neither path was allowed to write the plaintext ID to profiles', () => {
    expect(CHECKOUT).toMatch(/sa_id_number:\s*encryptedSaId,/);
    expect(ONBOARD).toMatch(/sa_id_number:\s*encrypted,/);
  });
});

describe('the two scripts', () => {
  it('the audit is a PURE READ — it never writes', () => {
    expect(AUDIT).not.toMatch(/\.update\(/);
    expect(AUDIT).not.toMatch(/\.insert\(/);
    expect(AUDIT).not.toMatch(/\.upsert\(/);
    expect(AUDIT).not.toMatch(/\.delete\(/);
  });

  it('the audit needs no HMAC key — it groups on decrypted plaintext, so it runs before the secret exists', () => {
    // Grouping on plaintext and grouping on the HMAC partition the rows
    // identically, so the audit gets the same answer without ever touching
    // the second secret — which is what lets it run BEFORE that secret is
    // provisioned, i.e. exactly when the duplicate picture is needed.
    // It NAMES the key in the message it prints when the persisted column
    // disagrees with the plaintext, which is the most useful thing to say
    // there. What it must never do is READ it.
    expect(AUDIT).not.toMatch(/process\.env\.SA_ID_LOOKUP_HMAC_KEY/);
    expect(AUDIT).not.toMatch(/hashIdForLookup/);
    expect(AUDIT).toMatch(/import \{ decryptId, maskId \}/);
  });

  it('the audit prints no SA ID in the clear', () => {
    expect(AUDIT).toMatch(/maskId\(plain\)/);
  });

  it('the backfill writes ONLY sa_id_lookup_hash — never sa_id_number, never a role, never a deletion', () => {
    const updates = [...BACKFILL.matchAll(/\.update\(([^)]*)\)/g)].map((m) => m[1]);
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u).toMatch(/^\{ sa_id_lookup_hash: hash \}$/);
    expect(BACKFILL).not.toMatch(/\.delete\(/);
    expect(BACKFILL).not.toMatch(/\.insert\(/);
    expect(BACKFILL).not.toMatch(/\.upsert\(/);
    // The one thing it must never re-write: the encrypted ID itself.
    expect(BACKFILL).not.toMatch(/sa_id_number:\s*(encrypt|plain|stored|hash)/);
    expect(BACKFILL).not.toMatch(/encryptId/);
  });

  it('the backfill refuses to run without the HMAC key, before touching a row', () => {
    const guard = BACKFILL.indexOf("process.env.SA_ID_LOOKUP_HMAC_KEY");
    const write = BACKFILL.indexOf('.update(');
    expect(guard).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(guard);
    expect(BACKFILL).toMatch(/hashIdForLookup\('0000000000000'\)/);   // key smoke-test
  });

  it('the backfill is idempotent — an already-correct row is skipped, not rewritten', () => {
    expect(BACKFILL).toMatch(/if \(row\.sa_id_lookup_hash === hash\) \{ alreadyCorrect \+= 1; continue; \}/);
  });

  it('the backfill reports decrypt failures instead of skipping them silently', () => {
    expect(BACKFILL).toMatch(/failures\.push\(/);
    expect(BACKFILL).toMatch(/FAILED \(reported, not skipped silently\)/);
  });

  it('the backfill verifies the invariant a UNIQUE constraint depends on, and exits non-zero if it fails', () => {
    // A row with an SA ID but a NULL hash is invisible to a partial unique
    // index — NULLs never collide — so Phase 2 would be unenforceable for
    // it. The script must not report success in that state.
    expect(BACKFILL).toMatch(/\.not\('sa_id_number', 'is', null\)[\s\S]{0,60}\.is\('sa_id_lookup_hash', null\)/);
    expect(BACKFILL).toMatch(/NOT ZERO[\s\S]{0,300}process\.exit\(1\)/);
  });

  it('supports --dry-run, so the write set can be inspected first', () => {
    expect(BACKFILL).toMatch(/const DRY = process\.argv\.includes\('--dry-run'\)/);
    expect(BACKFILL).toMatch(/if \(DRY\) \{[\s\S]{0,160}return;/);
  });
});

describe('Phase 2: uniqueness lives in exactly one migration, with the right predicate', () => {
  it('0097 is the ONLY migration that makes the hash unique', () => {
    // Both halves read the COMMENT-STRIPPED source. The column name used to
    // be matched against the raw file, which meant any migration that merely
    // discussed the constraint in its header — and happened to contain the
    // letters "unique" anywhere in its own DDL, an identifier like
    // `enforce_unique_verified_phone` being quite enough — was reported as a
    // second source of uniqueness. That is a false positive, and a
    // false-positive invariant is one somebody eventually edits the expected
    // value of rather than investigates.
    const named = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => {
        const d = ddl(readFileSync(resolve(MIG_DIR, f), 'utf8'));
        return /sa_id_lookup_hash/.test(d) && /\bUNIQUE\b/i.test(d);
      });
    expect(named).toEqual([UNIQ_NAME]);
  });

  it('is partial on role = patient — a doctor who is also a patient is two legitimate accounts', () => {
    // Read with comments stripped but string literals INTACT: the predicate
    // is itself a quoted literal, and ddl() blanks those.
    expect(UNIQ_SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS profiles_sa_id_lookup_hash_patient_uniq/);
    expect(UNIQ_SQL).toMatch(/ON profiles\(sa_id_lookup_hash\)/);
    expect(UNIQ_SQL).toMatch(/WHERE role = 'patient' AND sa_id_lookup_hash IS NOT NULL/);
  });

  it('does not touch sa_id_number, RLS, or any account row', () => {
    expect(UNIQ_DDL).not.toMatch(/ALTER COLUMN sa_id_number/i);
    expect(UNIQ_DDL).not.toMatch(/UPDATE profiles/i);
    expect(UNIQ_DDL).not.toMatch(/DELETE FROM/i);
    expect(UNIQ_DDL).not.toMatch(/CREATE POLICY|DROP POLICY|GRANT/i);
  });
});

describe('the server-side gate — the message, above the index that actually holds', () => {
  it('BOTH patient ID-capture paths refuse an ID another account already holds', () => {
    for (const src of [CHECKOUT, ONBOARD]) {
      expect(src).toMatch(/findPatientBySaId\(/);
      expect(src).toMatch(/An account already exists for this ID number/);
    }
  });

  it('excludes the caller from their own ID — re-submitting your own is not a duplicate', () => {
    expect(CHECKOUT).toMatch(/idOwner\.id !== prospectiveUserId/);
    expect(ONBOARD).toMatch(/idOwner\.id !== userId/);
  });

  it('the checkout gate runs BEFORE the account is created, so a refusal leaves no orphan', () => {
    const gate   = CHECKOUT.indexOf('findPatientBySaId(');
    const create = CHECKOUT.indexOf('svc.auth.admin.createUser(');
    expect(gate).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(gate);
  });

  it('a FAILED lookup refuses rather than proceeding', () => {
    // null means "nobody owns this ID, let them register". An error must
    // never be allowed to look like null, or the gate fails open in exactly
    // the situation it exists for.
    for (const src of [CHECKOUT, ONBOARD]) {
      expect(src).toMatch(/SA ID duplicate check failed/);
      expect(src).toMatch(/could not verify your ID number/);
    }
  });

  it('the copy routes them somewhere, rather than stranding them', () => {
    // The task's requirement: tell them plainly, and point at log in /
    // recovery. A vague message strands a real returning patient.
    //
    // AMENDED 2026-09-02 (audit A-03). On checkout the plain message is now
    // keyed on the DOOR, not on the case. An emailed invitation carries an
    // address the caller did not choose, so naming the situation discloses
    // nothing and the argument above holds. A POS/QR token carries an address
    // the caller typed, so with the bill's SA ID fixed this message versus the
    // generic one told a merchant whether a probed address held an account —
    // an enumeration oracle on a surface they can POST to in a loop. That door
    // gets one message for every refusal, and its Log in link returns to the
    // checkout page, which claims the plan by SA ID once they are signed in —
    // so nobody is stranded there either.
    expect(CHECKOUT).toMatch(/Forgot password/);
    expect(CHECKOUT).toMatch(/opts\.saIdDuplicate && tokenKind === 'invitation'/);
    expect(CHECKOUT).toMatch(/requireLogin:\s*true/);
    // The call site must actually ask for it, or the copy above is dead.
    expect(CHECKOUT).toMatch(/signInRequired\([\s\S]{0,60}\{ saIdDuplicate: true \}\)/);
    expect(ONBOARD).toMatch(/Forgot password/);
  });

  it('the app check is the message and the index is the enforcement — not the other way round', () => {
    // Pinned because it is the thing that would quietly rot: if someone
    // later drops the index believing the server action covers it, a
    // direct insert re-opens the hole. lib/patients/saIdUniqueness.pglite
    // .test.ts proves the index holds with no app in the picture.
    expect(UNIQ_DDL).toMatch(/CREATE UNIQUE INDEX/);
  });
});

describe('role changes across the partial index', () => {
  it('revokeSalesRole translates a unique violation instead of leaking raw Postgres', () => {
    expect(SALES).toMatch(/error\.code === '23505'/);
    expect(SALES).toMatch(/profiles_sa_id_lookup_hash_patient_uniq/);
    // Split across a string concatenation in the source, so matched on the
    // half that carries the meaning rather than on the line break.
    expect(SALES).toMatch(/registered to a different patient account/);
  });

  it('does not silently resolve the duplicate on the admin\'s behalf', () => {
    const revoke = SALES.slice(SALES.indexOf('export async function revokeSalesRole'));
    expect(revoke).not.toMatch(/sa_id_number:\s*null/);
    expect(revoke).not.toMatch(/sa_id_lookup_hash:\s*null/);
  });
});

describe('the cleanup script', () => {
  it('never deletes an account — it clears the ID and nothing else', () => {
    const updates = [...STRIP.matchAll(/\.update\(([^)]*)\)/g)].map((m) => m[1]);
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u).toMatch(/sa_id_number: null, sa_id_lookup_hash: null|onboarding_completed: true/);
    }
    expect(STRIP).not.toMatch(/\.delete\(/);
    expect(STRIP).not.toMatch(/auth\.admin\.deleteUser/);
  });

  it('touches only role = patient rows — staff are outside the constraint', () => {
    expect(STRIP).toMatch(/\.eq\('role', 'patient'\)/);
  });

  it('writes a restore file BEFORE the first clearing write', () => {
    const restore = STRIP.indexOf('writeFileSync(OUT');
    const clear   = STRIP.indexOf("update({ sa_id_number: null");
    expect(restore).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(restore);
  });

  it('refuses to strip an account that would be pushed back into onboarding', () => {
    // profiles.onboarding_completed is a cached write-once-true flag that
    // computeOnboarding short-circuits on. For a row where it is FALSE, the
    // identity step reads sa_id_number directly — so clearing the ID sends
    // that patient to /onboarding/identity, where the new gate refuses the
    // only ID they have. A locked-out account.
    expect(STRIP).toMatch(/onboarding_completed/);
    expect(STRIP).toMatch(/wouldRelock/);
    expect(STRIP).toMatch(/if \(!DRY\) process\.exit\(1\)/);
  });

  it('the opt-in flag fix only touches rows that satisfy every OTHER step', () => {
    expect(STRIP).toMatch(/--fix-stale-onboarding/);
    expect(STRIP).toMatch(/phone_verified_at && d\?\.salary_day !== null/);
  });

  it('verifies that 0097 can actually apply before reporting success', () => {
    expect(STRIP).toMatch(/SA IDs still on >1 patient account/);
    expect(STRIP).toMatch(/Migration 0097 would abort/);
  });
});
