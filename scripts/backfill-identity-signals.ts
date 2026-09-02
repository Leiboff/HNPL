#!/usr/bin/env tsx
//
// ─── Seed the link graph from what we already know ────────────────────────
//
//   pnpm backfill:identity-signals            # dry run, prints a summary
//   pnpm backfill:identity-signals --write    # actually writes
//
// WHY THIS EXISTS
//
// Migration 0138's opening argument is that correlation data cannot be
// backfilled: you cannot retrospectively learn which browser an account
// signed up from. That is true of device and IP. It is NOT true of two
// signals this platform has been storing all along and never compared
// across accounts:
//
//   • payment_methods.signature — `peach:BRAND:LAST4:MMYYYY`, computed
//     since migration 0019 purely to de-duplicate a patient's own cards.
//     It is identical across accounts and always has been.
//   • profiles.phone — carries no unique index, so one number can sit on
//     any number of accounts today, and nothing has ever noticed.
//
// So the graph does not have to start empty. It starts with every card and
// every phone number on the books, which is the difference between a control
// that is useful on day one and one that is useful in six months.
//
// WHY A SCRIPT AND NOT MIGRATION 0139
//
// The stored value is an HMAC under IDENTITY_SIGNAL_HMAC_KEY, and the
// database does not have that key — deliberately, so that a database
// compromise yields links rather than card numbers and phone numbers. A SQL
// migration could only do this by taking the key as a literal in a
// statement, which would put it in the query log, in the migration history,
// and in this repository. The key stays in the application, so the backfill
// runs in the application.
//
// SAFETY
//
// Reads two columns. Writes only through `record_identity_signals`, which
// upserts and cannot overwrite anything — a second run is a no-op except
// that it advances `hits`, which is why it defaults to a DRY RUN and needs
// --write to do anything at all.

import { createClient } from '@supabase/supabase-js';
import { signalsEnabled, hashSignal } from '../lib/security/identitySignals';

const WRITE = process.argv.includes('--write');

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  if (!signalsEnabled()) {
    fail(
      'IDENTITY_SIGNAL_HMAC_KEY is not set. Set it to the SAME value the '
      + 'deployment uses — a backfill under a different key writes hashes '
      + 'that will never match anything the running app computes, and the '
      + 'rows are indistinguishable from real ones afterwards.',
    );
  }

  const svc = createClient(url!, key!, { auth: { persistSession: false } });

  // ── Cards ───────────────────────────────────────────────────────────
  // Archived cards included on purpose: a card removed from an account is
  // still evidence that the account and the card were once linked, and
  // "removed it right after the charge" is a fraud pattern, not an exit.
  const { data: cards, error: cardErr } = await svc
    .from('payment_methods')
    .select('patient_id, signature')
    .not('signature', 'is', null);
  if (cardErr) fail(`could not read payment_methods: ${cardErr.message}`);

  // ── Phones ──────────────────────────────────────────────────────────
  // Only VERIFIED numbers. An unverified phone is a string the account
  // holder typed, so linking on it would let anyone attach their account to
  // a stranger's number — and, once the thresholds bite, drag that stranger
  // over one.
  const { data: phones, error: phoneErr } = await svc
    .from('profiles')
    .select('id, phone, phone_verified_at')
    .not('phone', 'is', null)
    .not('phone_verified_at', 'is', null);
  if (phoneErr) fail(`could not read profiles: ${phoneErr.message}`);

  type Row = { userId: string; kind: 'card' | 'phone'; raw: string };
  const rows: Row[] = [
    ...(cards ?? [])
      .filter((c) => c.patient_id && c.signature)
      .map((c) => ({ userId: c.patient_id as string, kind: 'card' as const, raw: c.signature as string })),
    ...(phones ?? [])
      .filter((p) => p.id && p.phone)
      .map((p) => ({ userId: p.id as string, kind: 'phone' as const, raw: p.phone as string })),
  ];

  // Group by account so each one is a single RPC call, and de-duplicate —
  // ON CONFLICT cannot touch the same row twice in one statement.
  const byUser = new Map<string, Map<string, { kind: string; value_hash: string }>>();
  let unhashable = 0;
  for (const r of rows) {
    const value_hash = hashSignal(r.kind, r.raw);
    if (!value_hash) { unhashable += 1; continue; }
    const key = `${r.kind}:${value_hash}`;
    if (!byUser.has(r.userId)) byUser.set(r.userId, new Map());
    byUser.get(r.userId)!.set(key, { kind: r.kind, value_hash });
  }

  // What the graph will actually say, before writing anything — the whole
  // reason for a dry run. A signal shared by many accounts on day one is
  // either a fraud ring that has been operating unobserved, or a threshold
  // that is set wrong. Both are worth knowing before the rules go live.
  const accountsPerValue = new Map<string, Set<string>>();
  for (const [userId, signals] of byUser) {
    for (const key of signals.keys()) {
      if (!accountsPerValue.has(key)) accountsPerValue.set(key, new Set());
      accountsPerValue.get(key)!.add(userId);
    }
  }
  const shared = [...accountsPerValue.entries()]
    .map(([key, users]) => ({ kind: key.split(':')[0], accounts: users.size }))
    .filter((s) => s.accounts > 1)
    .sort((a, b) => b.accounts - a.accounts);

  console.log(`cards read:            ${cards?.length ?? 0}`);
  console.log(`verified phones read:  ${phones?.length ?? 0}`);
  console.log(`unhashable (skipped):  ${unhashable}`);
  console.log(`accounts to write:     ${byUser.size}`);
  console.log(`distinct signals:      ${accountsPerValue.size}`);
  console.log(`shared by >1 account:  ${shared.length}`);
  for (const s of shared.slice(0, 20)) {
    console.log(`  ${s.kind.padEnd(6)} shared by ${s.accounts} accounts`);
  }

  if (!WRITE) {
    console.log('\nDry run — nothing written. Re-run with --write to apply.');
    return;
  }

  let ok = 0, failed = 0;
  for (const [userId, signals] of byUser) {
    const { error } = await svc.rpc('record_identity_signals', {
      p_user_id: userId,
      p_signals: [...signals.values()],
    });
    if (error) { failed += 1; console.error(`  ${userId}: ${error.message}`); }
    else ok += 1;
  }
  console.log(`\nwritten: ${ok} accounts, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
