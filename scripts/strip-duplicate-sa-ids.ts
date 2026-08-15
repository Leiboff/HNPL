/**
 * Duplicate cleanup — keeps ONE patient account per SA ID and clears the
 * ID from the rest, so that migration 0097's unique index can apply.
 *
 * DELIBERATELY NOT A DELETE. Every account survives, with its plans, its
 * payments, its cards and its login intact. What the non-survivors lose is
 * only the ability to be found by SA ID. Deleting a profile cascades to the
 * auth user (migration 0044) and is irreversible; this is not.
 *
 * SCOPE — role = 'patient' ONLY
 *   Migration 0097's index is partial on role='patient', because practice
 *   staff also carry an sa_id_number and a doctor who is also a patient is
 *   two legitimate accounts. Staff rows therefore cannot collide with
 *   anything and are never touched here — including a group where two
 *   staff members share an ID, which is a real data problem but not one
 *   this constraint or this script is scoped to.
 *
 * WHO SURVIVES
 *   Ranked, most-attached first, and the top of each group keeps its ID:
 *     1. has collected payments        (real money moved through it)
 *     2. has an active plan            (live obligation)
 *     3. most plans of any status      (most history to keep reachable)
 *     4. oldest created_at             (deterministic tie-break)
 *     5. lowest id                     (total order — no ambiguity, ever)
 *   The ranking is printed per group before anything is written, and the
 *   whole run is a no-op under --dry-run.
 *
 * REVERSIBILITY
 *   Before the first write, every value it is about to clear is saved to a
 *   JSON restore file (id + the exact stored sa_id_number and
 *   sa_id_lookup_hash). Restoring is a straight replay of that file. The
 *   file holds encrypted IDs, not plaintext, but treat it as sensitive and
 *   delete it once you are satisfied — it is written OUTSIDE the repo by
 *   default and the repo ignores *.restore.json regardless.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/strip-duplicate-sa-ids.ts --dry-run
 *   pnpm tsx --env-file=.env.local scripts/strip-duplicate-sa-ids.ts --out ./sa-id.restore.json
 *
 * Requires:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SA_ID_ENCRYPTION_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { decryptId, maskId } from '../lib/idEncryption';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.argv.includes('--dry-run');
/**
 * Correct profiles.onboarding_completed on rows that satisfy every other
 * criterion migration 0066 grandfathered on, before clearing their SA ID.
 * Without it the script refuses to strip such a row — see the block below.
 */
const FIX_STALE = process.argv.includes('--fix-stale-onboarding');

const outFlag = process.argv.indexOf('--out');
const OUT = outFlag !== -1 ? process.argv[outFlag + 1] : 'sa-id-strip.restore.json';

if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}
if (!process.env.SA_ID_ENCRYPTION_KEY) {
  console.error('Missing SA_ID_ENCRYPTION_KEY in .env.local — cannot decrypt.');
  process.exit(1);
}

const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

const PAGE = 1000;

type Profile = {
  id:                    string;
  email:                 string | null;
  role:                  string | null;
  first_name:            string | null;
  last_name:             string | null;
  sa_id_number:          string | null;
  sa_id_lookup_hash:     string | null;
  onboarding_completed:  boolean | null;
  created_at:            string | null;
};

type Stats = { plans: number; active: number; collected: number };

async function fetchPatients(): Promise<Profile[]> {
  const out: Profile[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, role, first_name, last_name, sa_id_number, sa_id_lookup_hash, onboarding_completed, created_at')
      .eq('role', 'patient')
      .not('sa_id_number', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('[strip] profiles read failed:', error.message); process.exit(1); }
    const rows = (data ?? []) as Profile[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

async function main() {
  console.log(`\n[strip] one SA ID = one patient account${DRY ? '  (DRY RUN — no writes)' : ''}\n`);

  const patients = await fetchPatients();
  console.log(`patient profiles with an SA ID: ${patients.length}`);

  // Group on decrypted plaintext — the same partition sa_id_lookup_hash
  // gives, but computable without the HMAC key and independent of whether
  // the backfill has run.
  const byPlain = new Map<string, Profile[]>();
  const undecryptable: Profile[] = [];
  for (const p of patients) {
    const stored = p.sa_id_number as string;
    let plain: string;
    if (stored.startsWith('v1:')) {
      try { plain = decryptId(stored).trim(); } catch { undecryptable.push(p); continue; }
    } else {
      plain = stored.trim();       // legacy unencrypted row
    }
    if (!plain) { undecryptable.push(p); continue; }
    const l = byPlain.get(plain) ?? []; l.push(p); byPlain.set(plain, l);
  }

  if (undecryptable.length) {
    console.log(`\nWARNING — ${undecryptable.length} row(s) could not be resolved to an ID and are LEFT ALONE:`);
    for (const p of undecryptable) console.log(`  ${p.id}  email=${p.email ?? '—'}`);
    console.log('  They keep whatever they hold. If any carries a NULL hash it will');
    console.log('  also be invisible to the unique index — resolve before relying on it.');
  }

  const groups = [...byPlain.entries()].filter(([, rows]) => rows.length > 1);
  if (!groups.length) {
    console.log('\nNo SA ID is held by more than one PATIENT account. Nothing to strip.\n');
    return;
  }

  // ── Attachment stats, in bulk ─────────────────────────────────────────
  const ids = groups.flatMap(([, rows]) => rows.map((r) => r.id));

  const { data: planRows } = await supabase
    .from('plans').select('patient_id, status').in('patient_id', ids);
  const { data: payRows } = await supabase
    .from('payments').select('patient_id, status').in('patient_id', ids);

  const stats = new Map<string, Stats>();
  const stat = (id: string) => {
    const s = stats.get(id) ?? { plans: 0, active: 0, collected: 0 };
    stats.set(id, s);
    return s;
  };
  for (const r of (planRows ?? []) as Array<{ patient_id: string; status: string | null }>) {
    const s = stat(r.patient_id); s.plans += 1;
    if (r.status === 'active') s.active += 1;
  }
  for (const r of (payRows ?? []) as Array<{ patient_id: string | null; status: string | null }>) {
    if (!r.patient_id) continue;
    if (r.status === 'collected') stat(r.patient_id).collected += 1;
  }

  /** Most-attached first; total order, so the survivor is never ambiguous. */
  function rank(a: Profile, b: Profile): number {
    const sa = stat(a.id), sb = stat(b.id);
    if ((sb.collected > 0 ? 1 : 0) !== (sa.collected > 0 ? 1 : 0)) return (sb.collected > 0 ? 1 : 0) - (sa.collected > 0 ? 1 : 0);
    if ((sb.active    > 0 ? 1 : 0) !== (sa.active    > 0 ? 1 : 0)) return (sb.active    > 0 ? 1 : 0) - (sa.active    > 0 ? 1 : 0);
    if (sb.plans !== sa.plans) return sb.plans - sa.plans;
    const ta = Date.parse(a.created_at ?? '') || 0;
    const tb = Date.parse(b.created_at ?? '') || 0;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : 1;
  }

  const toStrip: Profile[] = [];
  let n = 0;
  for (const [plain, rows] of groups) {
    n += 1;
    const ranked = [...rows].sort(rank);
    const keeper = ranked[0];
    const losers = ranked.slice(1);
    toStrip.push(...losers);

    console.log(`\n── group ${n}/${groups.length} — ${maskId(plain)} — ${rows.length} patient accounts`);
    for (const p of ranked) {
      const s = stat(p.id);
      const tag = p.id === keeper.id ? 'KEEP  ' : 'strip ';
      console.log(
        `   ${tag}${p.id}  ${p.email ?? '—'}  plans=${s.plans} active=${s.active} collected=${s.collected}  created=${p.created_at ?? '—'}`,
      );
    }
  }

  console.log(`\n══ keeping ${groups.length}, clearing the SA ID from ${toStrip.length} account(s) ══`);
  console.log('   (accounts, plans, payments and logins are all untouched)');

  // ── The one way this cleanup can hurt a live account ──────────────────
  //
  // profiles.onboarding_completed is a CACHED write-once-true flag, and
  // computeOnboarding short-circuits on it before it ever looks at
  // sa_id_number (lib/onboarding/state.ts). So for a patient already
  // marked complete, clearing the ID is invisible to onboarding.
  //
  // For a patient NOT yet marked complete, the identity step reads
  // sa_id_number directly — clearing it pushes them back to
  // /onboarding/identity, where re-entering the same ID now hits the
  // duplicate gate and refuses them. That is a locked-out account, so the
  // script stops rather than creating one.
  const wouldRelock = toStrip.filter((p) => !p.onboarding_completed);
  if (wouldRelock.length) {
    // Would 0066's own grandfathering backfill have marked them complete
    // today? If yes, the flag is merely STALE — checkout-origin patients
    // never pass through the onboarding flow that sets it, so it stays
    // false even once they have supplied everything it asks for. That
    // distinction decides whether the fix is "correct the cache" or "these
    // accounts genuinely are mid-onboarding".
    const ids = wouldRelock.map((p) => p.id);
    const { data: detail } = await supabase
      .from('profiles')
      .select('id, phone_verified_at, salary_day')
      .in('id', ids);
    const by = new Map<string, { phone_verified_at: string | null; salary_day: number | null }>();
    for (const r of (detail ?? []) as Array<{ id: string; phone_verified_at: string | null; salary_day: number | null }>) {
      by.set(r.id, r);
    }

    const staleRows: Profile[] = [];
    console.log(`\n${FIX_STALE ? 'NOTE' : 'STOP'} — ${wouldRelock.length} account(s) to be stripped have onboarding_completed = FALSE:`);
    for (const p of wouldRelock) {
      const d = by.get(p.id);
      const satisfied = !!d?.phone_verified_at && d?.salary_day !== null && d?.salary_day !== undefined;
      if (satisfied) staleRows.push(p);
      console.log(
        `  ${p.id}  ${p.email ?? '—'}  phone_verified=${!!d?.phone_verified_at} salary_day=${d?.salary_day ?? 'null'}` +
        `  ⇒ ${satisfied ? 'flag is STALE (every other step is satisfied)' : 'genuinely mid-onboarding'}`,
      );
    }
    const genuine = wouldRelock.length - staleRows.length;
    console.log(`\n  ${staleRows.length}/${wouldRelock.length} have a merely STALE flag; ${genuine} are genuinely mid-onboarding.`);

    if (!FIX_STALE) {
      console.log('  Clearing the SA ID sends the stale ones straight to /onboarding/identity,');
      console.log('  where the duplicate gate refuses the only ID they have. Re-run with');
      console.log('  --fix-stale-onboarding to correct the cache first, or resolve them by hand.');
      if (!DRY) process.exit(1);
    } else {
      // Correcting a stale cache, not granting anything: these rows satisfy
      // every criterion migration 0066's own grandfathering backfill used
      // (confirmed email, verified phone, SA ID, salary day). The flag is
      // false only because checkout-origin patients never pass through the
      // onboarding flow that sets it — a pre-existing inconsistency this
      // cleanup would otherwise turn into a lockout.
      //
      // The genuinely mid-onboarding rows are deliberately NOT touched.
      // They are stopped at the PHONE step, which comes before identity, so
      // clearing the ID does not change where they land today; if they ever
      // finish that step they meet the duplicate gate, which tells them to
      // log in to the account that kept the ID. For a real duplicate that
      // is the correct outcome, not a bug.
      console.log(`  --fix-stale-onboarding: marking ${staleRows.length} stale row(s) complete; leaving ${genuine} alone.`);
      if (!DRY) {
        let fixed = 0;
        for (const p of staleRows) {
          const { error } = await supabase
            .from('profiles')
            .update({ onboarding_completed: true, onboarding_completed_at: new Date().toISOString() })
            .eq('id', p.id);
          if (error) { console.error(`  flag fix failed for ${p.id}: ${error.message}`); continue; }
          fixed += 1;
        }
        console.log(`  onboarding flag corrected on ${fixed} row(s).`);
      }
    }
  } else {
    console.log('\n   onboarding check: every account to be stripped is already marked');
    console.log('   onboarding_completed, so none is pushed back into the ID step.');
  }

  if (DRY) {
    console.log('\n[strip] dry run — nothing written.\n');
    return;
  }

  // ── Restore file BEFORE the first write ───────────────────────────────
  const restore = toStrip.map((p) => ({
    id:                p.id,
    email:             p.email,
    sa_id_number:      p.sa_id_number,
    sa_id_lookup_hash: p.sa_id_lookup_hash,
  }));
  writeFileSync(OUT, JSON.stringify({ strippedAt: new Date().toISOString(), rows: restore }, null, 2), 'utf8');
  console.log(`\nrestore file written: ${OUT}  (${restore.length} rows — keep it until you are satisfied)`);

  let cleared = 0, errors = 0;
  for (const p of toStrip) {
    const { error } = await supabase
      .from('profiles')
      .update({ sa_id_number: null, sa_id_lookup_hash: null })
      .eq('id', p.id);
    if (error) { errors += 1; console.error(`  failed for ${p.id}: ${error.message}`); continue; }
    cleared += 1;
  }
  console.log(`\ncleared: ${cleared}   errors: ${errors}`);

  // ── Verification: is 0097 now applicable? ─────────────────────────────
  const after = await fetchPatients();
  const seen = new Map<string, number>();
  for (const p of after) {
    const stored = p.sa_id_number as string;
    let plain: string;
    try { plain = stored.startsWith('v1:') ? decryptId(stored).trim() : stored.trim(); } catch { continue; }
    seen.set(plain, (seen.get(plain) ?? 0) + 1);
  }
  const remaining = [...seen.values()].filter((c) => c > 1).length;
  console.log(`\nverification — SA IDs still on >1 patient account: ${remaining}`);
  if (remaining > 0) {
    console.log('  NOT ZERO. Migration 0097 would abort. Re-run and investigate.');
    process.exit(1);
  }
  console.log('  zero — migration 0097 can now be applied.\n');
}

main().catch((err) => {
  console.error('[strip] unexpected failure:', err);
  process.exit(1);
});
