/**
 * Encrypt the legacy profiles.sa_id_number rows still stored in plaintext.
 *
 * Migration 0033 made the app encrypt before writing, but nothing ever
 * revisited the rows written before that. Phase 1's audit found 18 of them;
 * the duplicate cleanup incidentally cleared 12, leaving a handful of real
 * SA ID numbers sitting in the clear. There is no upside to that state.
 *
 * WHY A SCRIPT AND NOT A MIGRATION
 *   The ciphertext can only be produced by encryptId(), which needs
 *   SA_ID_ENCRYPTION_KEY. Postgres does not hold that key and must not be
 *   given it — putting the encryption key inside the database it protects
 *   defeats the point. Same reasoning, and same shape, as
 *   scripts/backfill-sa-id-lookup-hash.ts and scripts/strip-duplicate-sa-ids.ts.
 *
 * DETECTION RULE — "does not start with v1:"
 *   encryptId has emitted exactly one format since the commit that
 *   introduced it: `v1:<b64 iv>:<b64 tag>:<b64 ciphertext>`. decryptId
 *   rejects any other version outright, so no other prefix has ever been
 *   storable. And a plaintext SA ID can never be mistaken for ciphertext:
 *   validateSaId requires 13 digits, so it cannot begin with "v1:". The
 *   test is therefore both correct and complete in both directions.
 *
 * THE HASH IS NOT AFFECTED
 *   sa_id_lookup_hash is HMAC(key, PLAINTEXT ID) — derived from the ID
 *   itself, never from whatever the column happens to hold. Phase 1's
 *   backfill hashed these rows from their stored (plaintext) value, which
 *   IS the ID, so the hash is already correct and encrypting the column
 *   leaves it correct. This script verifies that per row before writing
 *   rather than asserting it, and never writes the hash column.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/encrypt-legacy-sa-ids.ts --dry-run
 *   pnpm tsx --env-file=.env.local scripts/encrypt-legacy-sa-ids.ts --out sa-id-encrypt.restore.json
 *
 * Requires:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SA_ID_ENCRYPTION_KEY        (required)
 *   SA_ID_LOOKUP_HMAC_KEY       (optional — only to VERIFY the hash still lines up)
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { encryptId, decryptId, maskId, hashIdForLookup } from '../lib/idEncryption';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.argv.includes('--dry-run');

const outFlag = process.argv.indexOf('--out');
const OUT = outFlag !== -1 ? process.argv[outFlag + 1] : 'sa-id-encrypt.restore.json';

if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}
if (!process.env.SA_ID_ENCRYPTION_KEY) {
  console.error('Missing SA_ID_ENCRYPTION_KEY in .env.local — cannot encrypt.');
  process.exit(1);
}

// Prove the key works, both directions, before a single row is touched. A
// key that encrypts but does not round-trip would silently destroy IDs.
try {
  const probe = '9001015800086';
  if (decryptId(encryptId(probe)) !== probe) throw new Error('round-trip mismatch');
} catch (err) {
  console.error('SA_ID_ENCRYPTION_KEY is unusable:', err instanceof Error ? err.message : err);
  process.exit(1);
}

const CAN_CHECK_HASH = !!process.env.SA_ID_LOOKUP_HMAC_KEY;

const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

const PAGE = 1000;

type Profile = {
  id:                string;
  email:             string | null;
  role:              string | null;
  first_name:        string | null;
  last_name:         string | null;
  sa_id_number:      string | null;
  sa_id_lookup_hash: string | null;
  created_at:        string | null;
};

/** Signals that a row is seed/test data rather than a member of the public. */
function testSignals(p: Profile): string[] {
  const out: string[] = [];
  const email = (p.email ?? '').toLowerCase();
  const name  = `${p.first_name ?? ''} ${p.last_name ?? ''}`.toLowerCase();
  if (/\+/.test(email))                                          out.push('email uses a +tag');
  if (/(test|demo|qa|dummy|fake|example)/.test(email))            out.push('test-ish email');
  if (/(test|demo|qa|dummy|fake)/.test(name))                     out.push('test-ish name');
  if (/@(doctor\.co\.za|example\.com|test\.com|mailinator)/.test(email)) out.push('seed domain');
  return out;
}

async function fetchAll(): Promise<Profile[]> {
  const out: Profile[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, role, first_name, last_name, sa_id_number, sa_id_lookup_hash, created_at')
      .not('sa_id_number', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('[encrypt] profiles read failed:', error.message); process.exit(1); }
    const rows = (data ?? []) as Profile[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

async function main() {
  console.log(`\n[encrypt] legacy plaintext profiles.sa_id_number${DRY ? '  (DRY RUN — no writes)' : ''}\n`);
  if (!CAN_CHECK_HASH) {
    console.log('NOTE: SA_ID_LOOKUP_HMAC_KEY not set — the hash-consistency check is skipped.\n');
  }

  const rows = await fetchAll();
  const already = rows.filter((r) => (r.sa_id_number ?? '').startsWith('v1:'));
  const plain   = rows.filter((r) => !(r.sa_id_number ?? '').startsWith('v1:'));

  console.log(`rows with a non-null sa_id_number: ${rows.length}`);
  console.log(`already encrypted (skipped):       ${already.length}`);
  console.log(`stored in PLAINTEXT:               ${plain.length}`);

  if (!plain.length) {
    console.log('\nNothing to do — every SA ID on file is already encrypted.\n');
    return;
  }

  // Which plaintext IDs are shared with another row? Matters because 0097's
  // unique index keys on the HASH, which this script does not change — so
  // encryption cannot create or resolve a collision. Reported so that claim
  // is visible rather than assumed.
  const plainCounts = new Map<string, number>();
  for (const r of rows) {
    const v = r.sa_id_number as string;
    let id: string;
    try { id = v.startsWith('v1:') ? decryptId(v).trim() : v.trim(); } catch { continue; }
    plainCounts.set(id, (plainCounts.get(id) ?? 0) + 1);
  }

  console.log('\n── the rows this would encrypt ──');
  let hashMismatch = 0;
  let whitespace   = 0;

  for (const p of plain) {
    const stored = p.sa_id_number as string;
    const id     = stored.trim();
    const shared = (plainCounts.get(id) ?? 1) - 1;
    const sig    = testSignals(p);

    let hashNote = 'not checked';
    if (CAN_CHECK_HASH) {
      if (!p.sa_id_lookup_hash) {
        hashNote = 'NO HASH ON ROW';
        hashMismatch += 1;
      } else if (hashIdForLookup(id) === p.sa_id_lookup_hash) {
        hashNote = 'hash matches the plaintext (stays valid after encryption)';
      } else {
        hashNote = 'HASH DOES NOT MATCH THE PLAINTEXT';
        hashMismatch += 1;
      }
    }
    if (stored !== id) whitespace += 1;

    console.log(`  ${p.id}`);
    console.log(`    role=${p.role ?? '—'}  email=${p.email ?? '—'}  name=${(p.first_name ?? '').trim()} ${(p.last_name ?? '').trim()}`.trimEnd());
    console.log(`    id=${maskId(id)}  created=${p.created_at ?? '—'}`);
    console.log(`    shared with ${shared} other profile(s)`);
    console.log(`    ${hashNote}`);
    if (stored !== id) console.log('    NOTE: stored value has surrounding whitespace');
    if (sig.length)    console.log(`    test/seed signals: ${sig.join('; ')}`);
  }

  if (hashMismatch) {
    console.log(`\nSTOP — ${hashMismatch} row(s) have a hash that does not correspond to their plaintext.`);
    console.log('  Encrypting would not CAUSE that, but it would hide it: the plaintext');
    console.log('  is currently the only way to see the mismatch. Resolve first.');
    if (!DRY) process.exit(1);
  }
  if (whitespace) {
    console.log(`\nNOTE — ${whitespace} row(s) carry surrounding whitespace. They are encrypted`);
    console.log('  EXACTLY as stored, so the round-trip is byte-for-byte reversible.');
  }

  if (DRY) {
    console.log('\n[encrypt] dry run — nothing written.\n');
    return;
  }

  // ── Restore file BEFORE the first write ───────────────────────────────
  const restore = plain.map((p) => ({
    id:                p.id,
    email:             p.email,
    sa_id_number:      p.sa_id_number,
    sa_id_lookup_hash: p.sa_id_lookup_hash,
  }));
  writeFileSync(OUT, JSON.stringify({ encryptedAt: new Date().toISOString(), rows: restore }, null, 2), 'utf8');
  console.log(`\nrestore file written: ${OUT}  (${restore.length} rows — plaintext IDs; delete once satisfied)`);

  let written = 0, errors = 0;
  for (const p of plain) {
    const original = p.sa_id_number as string;
    const cipher   = encryptId(original);

    // Round-trip the value we are about to store, before storing it. If this
    // ever failed we would be writing an ID we cannot read back.
    if (decryptId(cipher) !== original) {
      errors += 1;
      console.error(`  refusing to write ${p.id}: ciphertext does not round-trip`);
      continue;
    }

    const { error } = await supabase
      .from('profiles')
      .update({ sa_id_number: cipher })
      .eq('id', p.id);
    if (error) { errors += 1; console.error(`  write failed for ${p.id}: ${error.message}`); continue; }
    written += 1;
  }

  console.log(`\nencrypted: ${written}   errors: ${errors}`);

  // ── Verification ──────────────────────────────────────────────────────
  const after = await fetchAll();
  const stillPlain = after.filter((r) => !(r.sa_id_number ?? '').startsWith('v1:'));

  // Round-trip every row we just wrote, from the database, against the
  // restore file — the prefix alone proves nothing about recoverability.
  let roundTripFailures = 0;
  const byId = new Map(after.map((r) => [r.id, r]));
  for (const r of restore) {
    const now = byId.get(r.id);
    if (!now?.sa_id_number) { roundTripFailures += 1; continue; }
    let back: string;
    try { back = decryptId(now.sa_id_number as string); } catch { roundTripFailures += 1; continue; }
    if (back !== r.sa_id_number) roundTripFailures += 1;
    if (CAN_CHECK_HASH && now.sa_id_lookup_hash !== r.sa_id_lookup_hash) {
      console.error(`  sa_id_lookup_hash CHANGED for ${r.id} — it must not have`);
      roundTripFailures += 1;
    }
  }

  console.log(`\nverification — profiles with an SA ID still in plaintext: ${stillPlain.length}`);
  console.log(`verification — rows that do not decrypt back to their original: ${roundTripFailures}`);
  if (stillPlain.length > 0 || roundTripFailures > 0) {
    console.log('  NOT CLEAN. The restore file has every original value.');
    process.exit(1);
  }
  console.log('  every SA ID on file is encrypted and decrypts back to what it was.\n');
}

main().catch((err) => {
  console.error('[encrypt] unexpected failure:', err);
  process.exit(1);
});
