#!/usr/bin/env tsx
//
// ─── Does the database still match the migrations? ────────────────────────
//
//   pnpm check:rls-drift              # reads .env.local
//
// Exit 0 = the live RLS catalog matches what the migrations describe.
// Exit 1 = drift. Exit 2 = could not check (missing env, RPC error).
//
// WHY THIS IS A SCRIPT AND NOT A TEST
//
// `lib/security/schemaInvariants.test.ts` runs in CI on every commit and
// replays the migrations, which tells you what a FRESH environment gets. It
// has no database and cannot have one — a check that needs production
// credentials in a unit-test runner is a check that either does not run or
// puts a service-role key somewhere it should not be.
//
// This is the other half. It needs the key, so it runs where the key already
// lives: a developer's machine, or a scheduled job with the secret injected.
// Audit R3-08 is the case for bothering — three policies existed only in the
// live database for months, production was TIGHTER than the repo, and a
// rebuild would have silently loosened it. Nothing about the running system
// looked wrong.
//
// SAFETY
//
// Read-only. The single database call is `rls_catalog_snapshot()` (migration
// 0137), which is STABLE, reads two catalog views, returns object names and
// rule shapes only — no application data — and is granted to service_role
// alone. This script never writes.

import { createClient } from '@supabase/supabase-js';
import {
  replaySchema,
  assertFullyParsed,
  diffSchemaAgainstCatalog,
  formatDriftReport,
  type CatalogSnapshot,
} from '../lib/security/schemaInvariants';

const OK = 0, DRIFT = 1, CANNOT_CHECK = 2;

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    fail(CANNOT_CHECK,
      'check-rls-drift: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n'
      + '  Locally:  pnpm check:rls-drift   (reads .env.local)\n'
      + '  Scheduled: inject both as secrets.\n'
      + '\n'
      + 'Exiting 2 (cannot check) rather than 0, so a misconfigured job is not\n'
      + 'mistaken for a clean result.');
  }

  // The parse has to be sound before its output is worth comparing.
  try {
    assertFullyParsed();
  } catch (err) {
    fail(CANNOT_CHECK, `check-rls-drift: ${err instanceof Error ? err.message : String(err)}`);
  }

  const schema = replaySchema();

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('rls_catalog_snapshot');

  if (error) {
    fail(CANNOT_CHECK,
      `check-rls-drift: rls_catalog_snapshot() failed — ${error.message}\n`
      + 'If the function is missing, this environment has not had migration 0137 applied.');
  }

  const snapshot = data as CatalogSnapshot | null;
  if (!snapshot?.policies || !snapshot?.triggers) {
    fail(CANNOT_CHECK, 'check-rls-drift: rls_catalog_snapshot() returned an unexpected shape.');
  }

  const report = diffSchemaAgainstCatalog(schema, snapshot);

  const counts =
    `migrations: ${schema.policies.size} policies / ${schema.triggers.size} triggers · `
    + `database: ${snapshot.policies.length} policies / ${snapshot.triggers.length} triggers`;

  if (report.ok) {
    console.log(`✓ No RLS drift. ${counts}`);
    process.exit(OK);
  }

  console.error(
    `✗ RLS DRIFT DETECTED. ${counts}\n`
    + formatDriftReport(report)
    + '\n\n'
    + 'A policy or trigger that exists only in the DATABASE was made by hand and\n'
    + 'will vanish on the next rebuild. One that exists only in the MIGRATIONS is a\n'
    + 'defence the repo claims but this environment is not running. Write the\n'
    + 'intended state back as a migration — 0136 is the worked example.',
  );
  process.exit(DRIFT);
}

main().catch((err) => {
  fail(CANNOT_CHECK, `check-rls-drift: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
