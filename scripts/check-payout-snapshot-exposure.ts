/**
 * READ-ONLY audit: how many payouts rows carry personal bank details in their
 * snapshot_* columns?
 *
 * Why this matters before widening payouts SELECT to is_practice_member:
 * RLS is ROW-level, not COLUMN-level. A policy that lets every active member
 * read their practice's payouts rows lets them read EVERY COLUMN of those
 * rows — including the five snapshot_* columns that captured a provider's
 * personal banking at activation time, back when payout_destination could be
 * 'provider'.
 *
 * The feature is gone but the columns deliberately remain (migration 0090's
 * note: historical rows must stay auditable). So the question is not whether
 * the columns exist — they do — but whether any row has DATA in them.
 *
 * Run:  pnpm tsx scripts/check-payout-snapshot-exposure.ts
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const svc = createClient(url, key, { auth: { persistSession: false } });

const SNAPSHOT_COLS = [
  'snapshot_bank_name',
  'snapshot_account_holder',
  'snapshot_account_number',
  'snapshot_branch_code',
  'snapshot_account_type',
] as const;

async function main() {
  const { count: total, error: totalErr } = await svc
    .from('payouts')
    .select('id', { count: 'exact', head: true });
  if (totalErr) { console.error('total count failed:', totalErr.message); process.exit(1); }

  console.log(`payouts rows total: ${total ?? 0}`);
  console.log('');

  let anyPopulated = 0;
  for (const col of SNAPSHOT_COLS) {
    const { count, error } = await svc
      .from('payouts')
      .select('id', { count: 'exact', head: true })
      .not(col, 'is', null);
    if (error) { console.error(`${col} failed:`, error.message); continue; }
    const n = count ?? 0;
    anyPopulated = Math.max(anyPopulated, n);
    console.log(`  ${col.padEnd(26)} non-null in ${n} row(s)`);
  }

  // Also: rows still recorded as having paid a provider directly. Those are
  // the rows whose snapshots would have been populated.
  const { count: providerRows } = await svc
    .from('payouts')
    .select('id', { count: 'exact', head: true })
    .eq('payout_destination', 'provider');

  console.log('');
  console.log(`payout_destination = 'provider': ${providerRows ?? 0} row(s)`);
  console.log('');
  if (anyPopulated === 0) {
    console.log('RESULT: no snapshot_* column holds data. Widening payouts SELECT');
    console.log('exposes no personal banking today — but the columns remain readable,');
    console.log('so any future row that populated them would be exposed to all members.');
  } else {
    console.log(`RESULT: ⚠️  up to ${anyPopulated} row(s) carry personal bank details.`);
    console.log('Widening payouts SELECT to is_practice_member would expose those');
    console.log('columns to EVERY active member of the practice, reception included.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
