/**
 * One-time (but RE-RUNNABLE) backfill of profiles.sa_id_lookup_hash.
 *
 * Migration 0096 adds the column empty. Only the two patient ID-capture
 * paths populate it going forward, so every profile that already held an
 * SA ID has NULL — and a NULL hash is a row that the uniqueness constraint
 * cannot see. This closes that gap.
 *
 * WHY THIS IS NOT A SQL MIGRATION
 *   The hash is derived from the PLAINTEXT SA ID, and the plaintext only
 *   exists after an AES-256-GCM decrypt with SA_ID_ENCRYPTION_KEY. Postgres
 *   does not hold that key and must not be given it — putting the
 *   encryption key inside the database it protects defeats the point.
 *
 * SAFE TO RE-RUN. Every write is `sa_id_lookup_hash = <derived>` and
 * nothing else; the derivation is deterministic, so a second run over
 * unchanged data writes identical values. Re-run it if
 * SA_ID_LOOKUP_HMAC_KEY is ever rotated — a mixed-key column would let
 * duplicates slip past the constraint, which is the one failure mode that
 * matters here.
 *
 * Reports, rather than silently skipping:
 *   • rows whose sa_id_number will not decrypt
 *   • rows still stored UNENCRYPTED (no 'v1:' prefix) — hashed from the
 *     stored value as-is, because for duplicate purposes a legacy
 *     plaintext ID is still that patient's ID
 *   • the post-run verification: any row with sa_id_number NOT NULL and
 *     sa_id_lookup_hash NULL. That count MUST be zero before a UNIQUE
 *     constraint means anything.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/backfill-sa-id-lookup-hash.ts --dry-run
 *   pnpm tsx --env-file=.env.local scripts/backfill-sa-id-lookup-hash.ts
 *
 * Requires:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (server key — bypasses RLS)
 *   SA_ID_ENCRYPTION_KEY        (to decrypt)
 *   SA_ID_LOOKUP_HMAC_KEY       (to derive the hash — MUST be the same
 *                                value the deployed app uses)
 */

import { createClient } from '@supabase/supabase-js';
import { decryptId, hashIdForLookup } from '../lib/idEncryption';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.argv.includes('--dry-run');

if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}
if (!process.env.SA_ID_ENCRYPTION_KEY) {
  console.error('Missing SA_ID_ENCRYPTION_KEY in .env.local — cannot decrypt.');
  process.exit(1);
}
if (!process.env.SA_ID_LOOKUP_HMAC_KEY) {
  console.error(
    'Missing SA_ID_LOOKUP_HMAC_KEY in .env.local — cannot derive the blind index.\n' +
    'Generate one with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n' +
    'and set the SAME value in the deployment environment before shipping the app change.',
  );
  process.exit(1);
}

// Fail fast and loudly on a malformed key, before touching a single row.
try {
  hashIdForLookup('0000000000000');
} catch (err) {
  console.error('SA_ID_LOOKUP_HMAC_KEY is unusable:', err instanceof Error ? err.message : err);
  process.exit(1);
}

const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

const PAGE = 1000;

type Row = {
  id:                string;
  role:              string | null;
  email:             string | null;
  sa_id_number:      string | null;
  sa_id_lookup_hash: string | null;
};

async function fetchAll(): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, role, email, sa_id_number, sa_id_lookup_hash')
      .not('sa_id_number', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      // The commonest cause on a first run: the column does not exist yet.
      console.error('[backfill] profiles read failed:', error.message);
      if (/sa_id_lookup_hash/.test(error.message)) {
        console.error('[backfill] Has migration 0096 been applied to this project?');
      }
      process.exit(1);
    }
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

async function main() {
  console.log(`\n[backfill] profiles.sa_id_lookup_hash${DRY ? '  (DRY RUN — no writes)' : ''}\n`);

  const rows = await fetchAll();
  console.log(`rows with a non-null sa_id_number: ${rows.length}`);

  const failures: Array<{ row: Row; reason: string }> = [];
  const legacy:   Row[] = [];
  const updates:  Array<{ id: string; hash: string }> = [];
  let alreadyCorrect = 0;

  for (const row of rows) {
    const stored = row.sa_id_number as string;
    let plain: string;

    if (stored.startsWith('v1:')) {
      try {
        plain = decryptId(stored).trim();
      } catch (err) {
        failures.push({ row, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (!plain) {
        failures.push({ row, reason: 'decrypted to an empty string' });
        continue;
      }
    } else {
      // Pre-encryption row. Its stored value IS the plaintext ID, and it is
      // still this patient's ID as far as duplicate detection goes, so it
      // gets a hash like any other. Reported so the unencrypted rows stay
      // visible rather than being quietly normalised.
      legacy.push(row);
      plain = stored.trim();
      if (!plain) {
        failures.push({ row, reason: 'stored value is blank' });
        continue;
      }
    }

    const hash = hashIdForLookup(plain);
    if (row.sa_id_lookup_hash === hash) { alreadyCorrect += 1; continue; }
    updates.push({ id: row.id, hash });
  }

  console.log(`already correct (nothing to do):   ${alreadyCorrect}`);
  console.log(`legacy UNENCRYPTED rows:           ${legacy.length}`);
  console.log(`FAILED to decrypt:                 ${failures.length}`);
  console.log(`to write:                          ${updates.length}`);

  if (failures.length) {
    console.log('\n── rows that FAILED (reported, not skipped silently) ──');
    for (const { row, reason } of failures) {
      console.log(`  ${row.id}  role=${row.role ?? '—'}  email=${row.email ?? '—'}`);
      console.log(`      stored prefix: ${(row.sa_id_number ?? '').slice(0, 24)}…`);
      console.log(`      reason: ${reason}`);
    }
    console.log('  These rows keep sa_id_lookup_hash NULL and would escape a');
    console.log('  UNIQUE constraint. Resolve them before enforcing uniqueness.');
  }

  if (legacy.length) {
    console.log('\n── rows whose sa_id_number is stored UNENCRYPTED ──');
    for (const row of legacy) {
      console.log(`  ${row.id}  role=${row.role ?? '—'}  email=${row.email ?? '—'}`);
    }
    console.log('  Hashed from the stored value as-is. Encrypting them is a');
    console.log('  separate concern — this script does not touch sa_id_number.');
  }

  if (DRY) {
    console.log('\n[backfill] dry run — nothing written.\n');
    return;
  }

  let written = 0;
  let writeErrors = 0;
  for (const { id, hash } of updates) {
    const { error } = await supabase
      .from('profiles')
      .update({ sa_id_lookup_hash: hash })
      .eq('id', id);
    if (error) {
      writeErrors += 1;
      console.error(`  write failed for ${id}: ${error.message}`);
      continue;
    }
    written += 1;
  }

  console.log(`\nwritten: ${written}   write errors: ${writeErrors}`);

  // ── Verification: the invariant a UNIQUE constraint depends on ─────────
  const { count: unhashed, error: verifyErr } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .not('sa_id_number', 'is', null)
    .is('sa_id_lookup_hash', null);

  if (verifyErr) {
    console.error('[backfill] verification query failed:', verifyErr.message);
    process.exit(1);
  }

  console.log(`\nverification — profiles with an SA ID but NO hash: ${unhashed ?? 0}`);
  if ((unhashed ?? 0) > 0) {
    console.log('  NOT ZERO. Those rows are invisible to a partial UNIQUE index');
    console.log('  (NULLs never collide), so uniqueness would be unenforceable');
    console.log('  for them. Fix before adding the constraint.');
    process.exit(1);
  }
  console.log('  zero — every SA ID on file now carries a hash.\n');
}

main().catch((err) => {
  console.error('[backfill] unexpected failure:', err);
  process.exit(1);
});
