// Node runtime required — crypto.timingSafeEqual for the cron auth, and the
// migration replay reads supabase/migrations/*.sql off disk.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import {
  replaySchema,
  assertFullyParsed,
  diffSchemaAgainstCatalog,
  formatDriftReport,
  type CatalogSnapshot,
} from '@/lib/security/schemaInvariants';

// ─── Daily RLS drift check ──────────────────────────────────────────────────
//
// THE DEFECT THIS WATCHES FOR (audit R3-08)
//
// Three RLS policies existed only in the live database for months — made by
// hand in the dashboard, never written back as a migration. Production was
// TIGHTER than the repo, so nothing looked wrong, and a `supabase db reset`
// or a disaster-recovery rebuild would have silently LOOSENED it: any active
// practice member, `role='staff'` included, would have read every plan and
// payment for their practice.
//
// Worse, the drift was contagious. Migration 0094 set out to move every
// provider RLS predicate off the legacy `plans.provider_id` and said so in
// its header — "Two policies did, and BOTH have to move". There were three.
// It could not see the third because that one lived only in production, so
// the tightening 0094 intended never reached `payments`. A hand-edit does
// not just diverge; it makes later migrations wrong.
//
// 0136 reconciled it. This job is what notices the next one.
//
// ─── WHY A CRON AND NOT CI ──────────────────────────────────────────────────
//
// `lib/security/schemaInvariants.test.ts` runs on every push and replays the
// migrations, which tells you what a FRESH environment gets. By construction
// it cannot see production — no test runner has a database, and a check that
// needs the service-role key in CI means putting that key in GitHub Actions
// secrets, where anyone who can push a workflow can read it.
//
// Here the key is already present and already scoped. This route reuses the
// `Bearer CRON_SECRET` pattern the other three jobs use, adds no credential
// anywhere, and reads through `rls_catalog_snapshot()` (migration 0137) —
// STABLE, service_role-only, returns object names and rule shapes and no
// application data, and cannot write.
//
// ─── WHAT IT DOES ON DRIFT ──────────────────────────────────────────────────
//
// Logs an ALERT line and records the run in `cron_runs` with `ok: false`, the
// same discipline the other three follow. It does NOT attempt a repair: the
// right resolution depends on which side is correct, and 0136 is the worked
// example of that being a judgement call (production's predicate was adopted
// for two policies and deliberately modernised for the third). A job that
// silently "fixed" RLS would be a worse problem than the drift.
//
// The HTTP status stays 200 on drift so Vercel does not retry a job whose
// answer will not change; `ok:false` in the body and in cron_runs is the
// signal. A genuine inability to check — bad env, RPC failure, an unparseable
// migration — is a 500, because that is a real failure and a retry may help.

const REQUIRE_CRON_SECRET = true;

async function handle(req: NextRequest): Promise<NextResponse> {
  // ── 1. Auth — identical posture to the other three cron routes ───────────
  const secret = process.env.CRON_SECRET;
  if (REQUIRE_CRON_SECRET) {
    if (!secret) {
      console.error('[cron/rls-drift] CRON_SECRET is not set — refusing to run.');
      return NextResponse.json({ error: 'Cron secret not configured.' }, { status: 500 });
    }
    const expected    = `Bearer ${secret}`;
    const receivedHdr = req.headers.get('authorization') ?? '';
    const expectedBuf = Buffer.from(expected, 'utf8');
    const receivedBuf = Buffer.from(receivedHdr, 'utf8');
    const authValid =
      receivedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(receivedBuf, expectedBuf);
    if (!authValid) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const startedAt = new Date();

  // ── 2. What the migrations say ───────────────────────────────────────────
  //
  // The .sql files reach the lambda via `outputFileTracingIncludes` in
  // next.config.ts — Next cannot trace a readdirSync, so without that entry
  // this throws at runtime rather than at build. The catch below is what
  // makes that failure legible instead of a bare 500.
  let expected;
  try {
    assertFullyParsed();
    expected = replaySchema();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cron/rls-drift] ALERT could not read the migrations', { message });
    return NextResponse.json(
      { ok: false, error: 'could_not_replay_migrations', message },
      { status: 500 },
    );
  }

  // ── 3. What the database has ─────────────────────────────────────────────
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await svc.rpc('rls_catalog_snapshot');
  if (error) {
    console.error('[cron/rls-drift] ALERT rls_catalog_snapshot() failed', { message: error.message });
    return NextResponse.json(
      { ok: false, error: 'snapshot_failed', message: error.message },
      { status: 500 },
    );
  }

  const snapshot = data as CatalogSnapshot | null;
  if (!snapshot?.policies || !snapshot?.triggers) {
    console.error('[cron/rls-drift] ALERT rls_catalog_snapshot() returned an unexpected shape');
    return NextResponse.json({ ok: false, error: 'snapshot_shape' }, { status: 500 });
  }

  // ── 4. Compare ───────────────────────────────────────────────────────────
  const report = diffSchemaAgainstCatalog(expected, snapshot);
  const finishedAt = new Date();

  const record = {
    ok: report.ok,
    migrations: { policies: expected.policies.size, triggers: expected.triggers.size },
    database:   { policies: snapshot.policies.length, triggers: snapshot.triggers.length },
    policies_only_in_database:   report.policiesOnlyInDatabase,
    policies_only_in_migrations: report.policiesOnlyInMigrations,
    policies_differing:          report.policiesDiffering,
    triggers_only_in_database:   report.triggersOnlyInDatabase,
    triggers_only_in_migrations: report.triggersOnlyInMigrations,
    triggers_differing:          report.triggersDiffering,
  };

  const { error: recordErr } = await svc.from('cron_runs').insert({
    job_name:    'rls-drift',
    started_at:  startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    summary:     record,
  });
  if (recordErr) {
    console.error('[cron/rls-drift] failed to record run', recordErr);
  }

  if (!report.ok) {
    // ALERT prefix so this is greppable alongside the other money-path alarms.
    console.error(
      '[cron/rls-drift] ALERT the live RLS catalog no longer matches the migrations'
      + formatDriftReport(report),
    );
  } else {
    console.log('[cron/rls-drift] no drift', record.migrations);
  }

  // 200 either way — see the header on why drift is not a retryable failure.
  return NextResponse.json(record);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

// POST so an operator can trigger a run by hand:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/rls-drift
export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
