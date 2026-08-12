import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { runPayoutBatches } from '@/lib/payments/runPayoutBatches';

// ─── Weekly payout batching cron ────────────────────────────────────────────
//
// Triggered by Vercel Cron (vercel.json) every THURSDAY at 00:00 UTC =
// 02:00 SAST, two hours after the window closes at Thursday 00:00 SAST.
//
// WHY THURSDAY AND NOT FRIDAY
// ───────────────────────────
// Closing a batch depends on nothing: not on collections, not on the previous
// batch having been settled, not on any human. Everything it needs already
// exists in payouts the moment the Wednesday cut-off passes. Practices are
// still PAID on Friday — but whoever runs the EFT needs a closed batch in
// hand before that, and a Friday-morning close gave them the same morning.
// Closing Thursday hands them a settled figure a full day early.
//
// WHY 02:00 SAST AND NOT MIDNIGHT
// ───────────────────────────────
// Two hours of buffer, because firing early is the one genuinely damaging
// failure. Vercel cron delivery is best-effort, and a run that lands even a
// minute BEFORE Thursday 00:00 SAST resolves to the PREVIOUS week's window
// (payoutWindowForRun walks back to the most recent Thursday boundary) — it
// would no-op on an already-batched week and leave the just-closed week
// unbatched for another seven days, without even registering as
// stranded_payouts. Two hours makes that unreachable.
//
// 00:00 UTC is also the same calendar DAY in both zones: SAST is UTC+2, so
// any slot in the first two SAST hours of Thursday earlier than this would
// have to be written as a WEDNESDAY cron string (`* * 3`) for a job that
// closes a Thursday window — an invitation for someone to "fix" the day
// field later and break it.
//
// It groups payouts rows into one batch per practice per week, covering
// plans ACTIVATED Thursday 00:00:00 → Wednesday 23:59:59 SAST. See
// lib/payments/payoutWindow.ts for the boundary rule and why the cut-off is
// end-of-day Wednesday rather than aligned to the 11:00 UTC collection cron,
// and migration 0090 for the DB-level idempotency guarantees.
//
// This job does NOT move money and does NOT create payouts rows. Closing a
// batch is fully automated; SUBMITTING it to the bank is deliberately not —
// settlement stays a platform-admin action (markBatchPaid) taken after the
// EFT has actually cleared, outside the app. The two steps are uncoupled on
// purpose: a batch closes whether or not anyone has settled the last one, and
// nothing here waits on a human. activateFirstInstalment likewise stays the
// only creator of payouts.
//
// So unlike collect-instalments this endpoint fires no real-money charges —
// but it decides what a practice is told they are owed and when, so it is
// authenticated to exactly the same standard.
//
// Vercel sends cron requests as GET with an Authorization: Bearer
// <CRON_SECRET> header. POST is also supported so an operator can trigger a
// run manually, which is how a missed week gets backfilled:
//
//   curl -X POST 'https://<host>/api/cron/payout-batches?weekEnding=2026-08-13' \
//        -H "Authorization: Bearer $CRON_SECRET"
//
// weekEnding is the EXCLUSIVE Thursday end of the window, as a SAST calendar
// date. Backfill exists because the normal window is strict: a batch labelled
// "Thu 6 – Wed 12" must contain exactly that, so a missed week is never
// silently swept into the next batch. The run summary's stranded_payouts
// count is how a miss becomes visible.

export const dynamic = 'force-dynamic';

// Toggle to require the CRON_SECRET env var be set. Defaults to true —
// turning it off (e.g. for a local dev run with no Vercel) needs a
// deliberate code change, not just an env var.
const REQUIRE_CRON_SECRET = true;

async function handle(req: NextRequest): Promise<NextResponse> {
  // ── 1. Auth ─────────────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  if (REQUIRE_CRON_SECRET) {
    if (!secret) {
      console.error('[cron/payout-batches] CRON_SECRET is not set — refusing to run.');
      return NextResponse.json({ error: 'Cron secret not configured.' }, { status: 500 });
    }
    // Constant-time compare via crypto.timingSafeEqual — identical to
    // app/api/cron/collect-instalments and the Peach webhook's signature
    // check. The length pre-check keeps a mismatched-size header from
    // throwing instead of cleanly rejecting.
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

  const startedAt  = new Date();
  const weekEnding = req.nextUrl.searchParams.get('weekEnding');

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // ── 2. Run. Safe to re-run: the batch row is an ON CONFLICT DO NOTHING
  //       upsert and membership is an atomic `batch_id IS NULL` claim, both
  //       enforced by the schema rather than by this route.
  let summary;
  try {
    summary = await runPayoutBatches(svc, { now: startedAt, weekEnding });
  } catch (e) {
    // A bad ?weekEnding= (not a Thursday) throws rather than silently
    // producing an overlapping window. Surface it as a 400, not a 500.
    const message = e instanceof Error ? e.message : String(e);
    console.error('[cron/payout-batches] run failed', message);
    const isBadWindow = message.includes('not a Thursday') || message.includes('not a valid');
    return NextResponse.json({ error: message }, { status: isBadWindow ? 400 : 500 });
  }

  const finishedAt = new Date();
  const record = {
    started_at:  startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    ...summary,
  };

  // ── 3. Record the run for observability. A payout runner that silently
  //       stops is a money-not-paid disaster with a one-week detection lag,
  //       so the same cron_runs discipline applies here as to collection.
  //       stranded_payouts > 0 in this record is the alarm for a missed week.
  const { error: recordErr } = await svc.from('cron_runs').insert({
    job_name:    'payout-batches',
    started_at:  startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    summary:     record,
  });
  if (recordErr) {
    console.error('[cron/payout-batches] failed to record run', recordErr);
  }

  console.log('[cron/payout-batches] run summary', record);

  return NextResponse.json({ ok: summary.errors.length === 0, ...record });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
