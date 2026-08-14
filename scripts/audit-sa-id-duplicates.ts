/**
 * Duplicate-SA-ID audit — PURE READ. Writes nothing, ever.
 *
 * Reveals which profiles share an SA ID number before any uniqueness is
 * enforced (see supabase/migrations/0096_sa_id_lookup_hash.sql). Because
 * profiles.sa_id_number is AES-256-GCM with a fresh random IV per call,
 * two rows holding the same ID look nothing alike in the database — the
 * grouping cannot be done in SQL. This script decrypts every row in
 * process, groups on the PLAINTEXT, and reports.
 *
 * Grouping on plaintext here is deliberately equivalent to grouping on
 * hashIdForLookup(): HMAC-SHA256 is injective in practice, so
 * "same plaintext" and "same hash" partition the rows identically. Doing
 * it on plaintext means this audit needs no SA_ID_LOOKUP_HMAC_KEY and can
 * therefore be run BEFORE that secret is provisioned — which is exactly
 * when you want to see the duplicate picture.
 *
 * No SA ID is ever printed. Output is masked (last 4 only), the same form
 * the admin surfaces use.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/audit-sa-id-duplicates.ts
 *
 * Requires:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (server key — bypasses RLS)
 *   SA_ID_ENCRYPTION_KEY        (to decrypt; NOT the lookup HMAC key)
 */

import { createClient } from '@supabase/supabase-js';
import { decryptId, maskId } from '../lib/idEncryption';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  id:           string;
  email:        string | null;
  role:         string | null;
  first_name:   string | null;
  last_name:    string | null;
  sa_id_number: string | null;
  created_at:   string | null;
};

type Plan = {
  id:         string;
  patient_id: string;
  status:     string | null;
  total_amount: number | null;
  created_at: string | null;
};

type Payment = {
  patient_id: string | null;
  status:     string | null;
  amount:     number | null;
};

/**
 * Heuristics for "obviously not a real member of the public". Reported as
 * a SIGNAL, never acted on — the decision about what happens to any
 * account is the operator's.
 */
function testAccountSignals(p: Profile): string[] {
  const signals: string[] = [];
  const email = (p.email ?? '').toLowerCase();
  const name  = `${p.first_name ?? ''} ${p.last_name ?? ''}`.toLowerCase();

  if (/\+/.test(email))                         signals.push('email uses a +tag');
  if (/(test|demo|qa|dummy|fake|example)/.test(email)) signals.push('test-ish email');
  if (/(test|demo|qa|dummy|fake|asdf|zzz)/.test(name)) signals.push('test-ish name');
  if (/@(example\.com|test\.com|mailinator|yopmail)/.test(email)) signals.push('throwaway domain');
  if (!p.first_name?.trim() || !p.last_name?.trim()) signals.push('name incomplete');

  return signals;
}

async function fetchAllProfiles(): Promise<Profile[]> {
  const out: Profile[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, role, first_name, last_name, sa_id_number, created_at')
      .not('sa_id_number', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('[audit] profiles read failed:', error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as Profile[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

async function main() {
  console.log('\n[audit] one SA ID = one account? — read-only duplicate scan\n');

  const profiles = await fetchAllProfiles();
  console.log(`profiles with a non-null sa_id_number: ${profiles.length}`);

  // ── Decrypt, keeping failures visible rather than dropping them ────────
  const byPlain   = new Map<string, Profile[]>();
  const failures: Array<{ p: Profile; reason: string }> = [];
  const legacyPlaintext: Profile[] = [];

  for (const p of profiles) {
    const stored = p.sa_id_number as string;
    if (!stored.startsWith('v1:')) {
      // Pre-encryption legacy row. Still a real ID for duplicate purposes.
      legacyPlaintext.push(p);
      const plain = stored.trim();
      const list = byPlain.get(plain) ?? [];
      list.push(p);
      byPlain.set(plain, list);
      continue;
    }
    try {
      const plain = decryptId(stored).trim();
      if (!plain) { failures.push({ p, reason: 'decrypted to empty string' }); continue; }
      const list = byPlain.get(plain) ?? [];
      list.push(p);
      byPlain.set(plain, list);
    } catch (err) {
      failures.push({ p, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(`decrypted successfully:                ${profiles.length - failures.length}`);
  console.log(`legacy UNENCRYPTED (no "v1:" prefix):  ${legacyPlaintext.length}`);
  console.log(`FAILED to decrypt:                     ${failures.length}`);
  console.log(`distinct SA IDs:                       ${byPlain.size}`);

  if (failures.length) {
    console.log('\n── rows that FAILED to decrypt (reported, not skipped) ──');
    for (const { p, reason } of failures) {
      console.log(`  ${p.id}  role=${p.role ?? '—'}  email=${p.email ?? '—'}  created=${p.created_at ?? '—'}`);
      console.log(`      stored prefix: ${(p.sa_id_number ?? '').slice(0, 24)}…`);
      console.log(`      reason: ${reason}`);
    }
  }

  if (legacyPlaintext.length) {
    console.log('\n── legacy rows stored UNENCRYPTED ──');
    for (const p of legacyPlaintext) {
      console.log(`  ${p.id}  role=${p.role ?? '—'}  email=${p.email ?? '—'}  created=${p.created_at ?? '—'}`);
    }
  }

  // ── The duplicate groups ──────────────────────────────────────────────
  const groups = [...byPlain.entries()]
    .filter(([, rows]) => rows.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  const dupProfileCount = groups.reduce((n, [, rows]) => n + rows.length, 0);

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`duplicate groups (an SA ID on >1 profile): ${groups.length}`);
  console.log(`profiles inside a duplicate group:         ${dupProfileCount}`);
  console.log('══════════════════════════════════════════════════════════');

  if (!groups.length) {
    console.log('\nNo SA ID is shared by more than one profile. A UNIQUE constraint');
    console.log('on the blind index would apply cleanly with no cleanup.\n');
    return;
  }

  // Everything below is per-account detail. Fetched once, in bulk.
  const dupIds = groups.flatMap(([, rows]) => rows.map((r) => r.id));

  const { data: planRows, error: planErr } = await supabase
    .from('plans')
    .select('id, patient_id, status, total_amount, created_at')
    .in('patient_id', dupIds);
  if (planErr) console.error('[audit] plans read failed:', planErr.message);

  const { data: payRows, error: payErr } = await supabase
    .from('payments')
    .select('patient_id, status, amount')
    .in('patient_id', dupIds);
  if (payErr) console.error('[audit] payments read failed:', payErr.message);

  const { data: cardRows, error: cardErr } = await supabase
    .from('payment_methods')
    .select('patient_id, last_four')
    .in('patient_id', dupIds);
  if (cardErr) console.error('[audit] payment_methods read failed:', cardErr.message);

  const plansBy = new Map<string, Plan[]>();
  for (const r of (planRows ?? []) as Plan[]) {
    const l = plansBy.get(r.patient_id) ?? []; l.push(r); plansBy.set(r.patient_id, l);
  }
  const paysBy = new Map<string, Payment[]>();
  for (const r of (payRows ?? []) as Payment[]) {
    if (!r.patient_id) continue;
    const l = paysBy.get(r.patient_id) ?? []; l.push(r); paysBy.set(r.patient_id, l);
  }
  const cardsBy = new Map<string, number>();
  for (const r of (cardRows ?? []) as Array<{ patient_id: string }>) {
    cardsBy.set(r.patient_id, (cardsBy.get(r.patient_id) ?? 0) + 1);
  }

  let n = 0;
  for (const [plain, rows] of groups) {
    n += 1;
    const roles = [...new Set(rows.map((r) => r.role ?? '—'))];
    console.log(`\n── group ${n}/${groups.length} — ${maskId(plain)} — ${rows.length} profiles — roles: ${roles.join(', ')}`);
    if (roles.length > 1) {
      console.log('   NOTE: mixed roles. A staff member who is also a patient is TWO');
      console.log('   legitimate accounts on one ID — a global UNIQUE would reject it.');
    }

    for (const p of rows) {
      const plans    = plansBy.get(p.id) ?? [];
      const pays     = paysBy.get(p.id)  ?? [];
      const collected = pays.filter((x) => x.status === 'collected');
      const collectedTotal = collected.reduce((s, x) => s + Number(x.amount ?? 0), 0);
      const cards    = cardsBy.get(p.id) ?? 0;
      const signals  = testAccountSignals(p);

      const verdict =
        collected.length > 0                      ? 'REAL — has collected money'
        : plans.some((x) => x.status === 'active') ? 'REAL — has an active plan'
        : plans.length > 0                         ? 'has plans, none active'
        : signals.length >= 2                      ? 'likely TEST/DEMO'
        :                                            'empty — no plans, no payments';

      console.log(`   • ${p.id}`);
      console.log(`     role=${p.role ?? '—'}  email=${p.email ?? '—'}  name=${(p.first_name ?? '').trim()} ${(p.last_name ?? '').trim()}`.trimEnd());
      console.log(`     created=${p.created_at ?? '—'}`);
      console.log(`     plans=${plans.length}${plans.length ? ` [${plans.map((x) => x.status ?? '—').join(', ')}]` : ''}`);
      console.log(`     payments=${pays.length}  collected=${collected.length}  collected_total=R${collectedTotal.toFixed(2)}  saved_cards=${cards}`);
      if (signals.length) console.log(`     test/demo signals: ${signals.join('; ')}`);
      console.log(`     ⇒ ${verdict}`);
    }
  }

  console.log('\n[audit] read-only — nothing was written. No account was modified.\n');
}

main().catch((err) => {
  console.error('[audit] unexpected failure:', err);
  process.exit(1);
});
