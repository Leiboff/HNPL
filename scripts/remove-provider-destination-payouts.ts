import { createClient } from '@supabase/supabase-js';

// ─── One-off: delete in-flight provider-destination payouts ─────────────
//
// Context: the per-provider payout destination is removed (one practice =
// one bank account = one deposit — see migration 0090 and the note in
// lib/payments/activateFirstInstalment.ts). Rows already written under the
// old rule with status='pending' would otherwise be swept into a weekly
// batch whose total implies a single deposit to the PRACTICE, while the row
// itself says the money is owed to a doctor's personal account. That
// mismatch is exactly what batching exists to prevent.
//
// Decision (explicit, from the build brief): all current data is test data,
// so these rows are DELETED rather than honoured or converted. No
// honour-vs-convert logic is built.
//
// SCOPE — deliberately narrow:
//   • status = 'pending'                   — never touch settled history
//   • payout_destination = 'provider'      — practice-destined rows untouched
// Rows with status='paid' and destination='provider' are LEFT ALONE: money
// really moved, and the snapshot columns on those rows are the audit trail.
// That is also why migration 0090 does not drop any of those columns.
//
// Run:
//   pnpm tsx --env-file=.env.local scripts/remove-provider-destination-payouts.ts
//   pnpm tsx --env-file=.env.local scripts/remove-provider-destination-payouts.ts --apply
//
// Without --apply it only REPORTS. Nothing is deleted until you pass the
// flag — a destructive one-off against real infrastructure should not be a
// single mistyped command away.

const APPLY = process.argv.includes('--apply');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  console.error('Run with: pnpm tsx --env-file=.env.local scripts/remove-provider-destination-payouts.ts');
  process.exit(1);
}

const svc = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  // ── 1. Look before touching anything ─────────────────────────────────
  const { data: targets, error: readErr } = await svc
    .from('payouts')
    .select('id, practice_id, plan_id, provider_id, net_amount, status, payout_destination, created_at')
    .eq('status', 'pending')
    .eq('payout_destination', 'provider')
    .order('created_at', { ascending: true });

  if (readErr) {
    console.error('Read failed:', readErr.message);
    process.exit(1);
  }

  const rows = targets ?? [];
  console.log(`\nPending payouts with payout_destination='provider': ${rows.length}`);
  for (const r of rows) {
    console.log(
      `  ${r.id}  plan=${r.plan_id}  practice=${r.practice_id}  ` +
      `provider=${r.provider_id ?? '—'}  net=R${r.net_amount}  created=${r.created_at}`,
    );
  }

  // Context, so the report can state what was left alone and why.
  const [{ count: paidProvider }, { count: pendingPractice }] = await Promise.all([
    svc.from('payouts').select('id', { count: 'exact', head: true })
      .eq('status', 'paid').eq('payout_destination', 'provider'),
    svc.from('payouts').select('id', { count: 'exact', head: true })
      .eq('status', 'pending').eq('payout_destination', 'practice'),
  ]);
  console.log(`\nLeft untouched: ${paidProvider ?? 0} PAID provider-destination rows (audit trail),`);
  console.log(`                ${pendingPractice ?? 0} pending practice-destination rows (normal).`);

  if (rows.length === 0) {
    console.log('\nNothing to delete.');
    // Still report the orphan picture — after a successful --apply run this
    // is the verification pass, and it must not be skipped just because the
    // delete is now a no-op.
    await reportOrphanConsequence();
    return;
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --apply to delete the rows above.');
    return;
  }

  // ── 2. Delete, scoped by the same two predicates, not by the id list ──
  // Re-asserting both predicates in the DELETE means a row that changed
  // status between the read and the write is not deleted by id alone.
  const { data: deleted, error: delErr } = await svc
    .from('payouts')
    .delete()
    .eq('status', 'pending')
    .eq('payout_destination', 'provider')
    .select('id');

  if (delErr) {
    console.error('Delete failed:', delErr.message);
    process.exit(1);
  }

  console.log(`\nDeleted ${(deleted ?? []).length} row(s).`);

  // ── 3. Verify ────────────────────────────────────────────────────────
  const { count: remaining } = await svc
    .from('payouts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .eq('payout_destination', 'provider');
  console.log(`Remaining pending provider-destination rows: ${remaining ?? 0}`);

  await reportOrphanConsequence();
}

/**
 * Deleting a payout leaves its plan with none. If that plan is still active,
 * the weekly runner will count it under orphan_active_plans — by design: the
 * runner reports orphans rather than creating payouts, because
 * activateFirstInstalment must stay the only creator (payouts.plan_id UNIQUE,
 * 0087). Printed here so the expected number is known in advance and a real
 * orphan later isn't mistaken for this one.
 */
async function reportOrphanConsequence() {
  const { data: active } = await svc.from('plans').select('id').eq('status', 'active');
  const ids = (active ?? []).map((p) => p.id as string);
  if (ids.length === 0) {
    console.log('\nActive plans: 0 — nothing for the runner to report as an orphan.');
    return;
  }
  const { data: covered } = await svc.from('payouts').select('plan_id').in('plan_id', ids);
  const have = new Set((covered ?? []).map((r) => r.plan_id as string));
  const orphans = ids.filter((id) => !have.has(id));
  console.log(
    `\nActive plans: ${ids.length}. With NO payouts row: ${orphans.length} ` +
    '(the runner will report this as orphan_active_plans — expected, not a bug).',
  );
  for (const id of orphans) console.log(`  orphan plan: ${id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
