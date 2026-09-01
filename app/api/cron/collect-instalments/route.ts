import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { attemptChargeInstalment } from '@/lib/payments/chargeInstalment';
import { assessDunningFee } from '@/lib/payments/assessDunningFee';
import { sweepStuckProcessing, type SweepSummary } from '@/lib/payments/sweepStuckProcessing';

// ─── Daily installment collection cron ──────────────────────────────────────
//
// Triggered by Vercel Cron (vercel.json) once per day at 11:00 UTC =
// 13:00 SAST — early afternoon so most South African salaries have
// landed before we attempt to charge.
//
// Vercel sends cron requests as GET with an Authorization: Bearer
// <CRON_SECRET> header. We also support POST so the operator can
// manually trigger a run via curl (see the README at the bottom of
// this file for the exact command).
//
// The route is the ONLY public endpoint that can fire real-money
// charges against stored cards on a schedule. Unauthenticated requests
// MUST be rejected.
//
// TWO jobs in one daily run, back to back:
//   1. Collect due instalments (charge attempts — step 2 below).
//   2. Assess grace-elapsed dunning fees (step 5 below) — the 24-hour
//      self-pay window a failed attempt gets before its Default Fee
//      posts. Same daily cadence serves both; no second Vercel Cron
//      entry needed. Because the run is once daily at a fixed time,
//      "24 hours" in practice means "the next day's run", which is the
//      granularity this whole system already operates at.
//   3. Sweep stuck 'processing' claims (step 6 below) — the safety net
//      under every path that claims a row and then calls the provider.
//      A claim left in 'processing' is invisible to jobs 1 and 2 both,
//      so without this a single stranded claim is a permanent silent
//      write-off of everything it covers (audit A-13).
//
//      It runs LAST, deliberately. Its cutoff is hours old, so nothing
//      this run just claimed is in scope — but running it first would
//      make that a matter of arithmetic rather than of ordering, and a
//      sweep that races the collector it shares a process with is not a
//      safety net.

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
      console.error('[cron/collect-instalments] CRON_SECRET is not set — refusing to run.');
      return NextResponse.json({ error: 'Cron secret not configured.' }, { status: 500 });
    }
    // Constant-time compare via crypto.timingSafeEqual — same pattern
    // the Peach webhook handler uses for its HMAC signature check
    // (app/api/payments/peach/webhook/route.ts). The length check guards
    // against a mismatched-size header throwing instead of cleanly
    // rejecting; an attacker-supplied short/garbage header gets the
    // same 401 as a wrong-secret-of-equal-length one. (M5 fix, 2026-06-22.)
    const expected     = `Bearer ${secret}`;
    const receivedHdr  = req.headers.get('authorization') ?? '';
    const expectedBuf  = Buffer.from(expected, 'utf8');
    const receivedBuf  = Buffer.from(receivedHdr, 'utf8');
    const authValid =
      receivedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(receivedBuf, expectedBuf);
    if (!authValid) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const startedAt = new Date();
  const todayStr  = startedAt.toISOString().slice(0, 10);

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // ── 2. Find due payments. Two-source pull — scheduled rows by
  //       due_date (first attempts) and failed rows by the dunning
  //       ladder's next_attempt_date. We do not need a separate
  //       write-off sweep anymore — the ladder transitions cap-hit
  //       rows to terminal 'defaulted' inline (in the webhook), so
  //       they're already excluded from the SELECT below by status.
  //
  //   • plan.status = 'active'             — don't charge cancelled or
  //                                          completed plans.
  //   • plan.peach_registration_id   — must have a stored token.
  //                                          Filter at the join.
  //   • last_dunning_attempt_date < today  — belt-and-braces same-day
  //                                          re-run guard. The atomic
  //                                          claim's status filter is
  //                                          the primary lock; this
  //                                          ensures the SELECT itself
  //                                          doesn't even surface rows
  //                                          we already attempted today.

  const sameDayGuard = `last_dunning_attempt_date.is.null,last_dunning_attempt_date.lt.${todayStr}`;

  // kind='instalment' is EXPLICIT. Settlement rows (kind='settlement',
  // added by 0058) happen to be excluded today by accident — they are
  // created in 'processing' (not 'scheduled') and have NULL
  // next_attempt_date — but the charging path must not rely on that
  // accident. A future change to settlement-row creation that breaks
  // either of those incidental filters would otherwise cause the cron
  // to fire a duplicate per-instalment charge against a settlement-row
  // total. The explicit kind filter is the load-bearing guarantee.
  const [scheduledRes, failedRes] = await Promise.all([
    svc
      .from('payments')
      .select('id, plans!inner(status, peach_registration_id)')
      .eq('kind', 'instalment')
      .eq('status', 'scheduled')
      .lte('due_date', todayStr)
      .or(sameDayGuard)
      .eq('plans.status', 'active')
      .not('plans.peach_registration_id', 'is', null),
    svc
      .from('payments')
      .select('id, plans!inner(status, peach_registration_id)')
      .eq('kind', 'instalment')
      .eq('status', 'failed')
      .not('next_attempt_date', 'is', null)
      .lte('next_attempt_date', todayStr)
      .or(sameDayGuard)
      .eq('plans.status', 'active')
      .not('plans.peach_registration_id', 'is', null),
  ]);

  if (scheduledRes.error) {
    console.error('[cron/collect-instalments] scheduled-payments query failed', scheduledRes.error);
    return NextResponse.json({ error: scheduledRes.error.message }, { status: 500 });
  }
  if (failedRes.error) {
    console.error('[cron/collect-instalments] failed-payments query failed', failedRes.error);
    return NextResponse.json({ error: failedRes.error.message }, { status: 500 });
  }

  const due = ([...(scheduledRes.data ?? []), ...(failedRes.data ?? [])]) as Array<{ id: string }>;

  // ── 4. Attempt each. attemptChargeInstalment is its own atomic claim;
  //       running concurrent batches against overlapping ids is safe.
  let charged           = 0;
  let claimLost         = 0;
  let transportErrors   = 0;
  const transportErrorIds: string[] = [];

  for (const row of due) {
    const outcome = await attemptChargeInstalment(svc, row.id, { today: todayStr });
    if (outcome.kind === 'charged') {
      charged++;
    } else if (outcome.kind === 'claim_lost') {
      claimLost++;
    } else {
      transportErrors++;
      transportErrorIds.push(row.id);
      console.error('[cron/collect-instalments] transport error charging payment', {
        paymentId: row.id,
        reference: outcome.reference,
        error:     outcome.error,
      });
    }
  }

  // ── 5. Assess pending dunning fees — the OTHER half of a failed
  //       instalment's life. A failed attempt doesn't earn its Default
  //       Fee immediately any more (see lib/payments/dunning.ts /
  //       assessDunningFee.ts); the patient gets a 24-hour self-pay
  //       window first (payments.dunning_grace_until, stamped by the
  //       Peach webhook). This is the ONLY place that window gets
  //       checked: rows still 'failed' whose grace has elapsed.
  //
  //       A self-pay within the window already moved the row out of
  //       'failed' via the normal success path, so it's naturally
  //       excluded here — no extra guard needed. assessDunningFee is its
  //       own atomic claim (mirrors attemptChargeInstalment), so running
  //       concurrent batches against overlapping ids is safe here too.
  const { data: graceElapsedRows, error: graceErr } = await svc
    .from('payments')
    .select('id')
    .eq('kind', 'instalment')
    .eq('status', 'failed')
    .not('dunning_grace_until', 'is', null)
    .lte('dunning_grace_until', todayStr);

  if (graceErr) {
    console.error('[cron/collect-instalments] grace-elapsed query failed', graceErr);
  }

  let feesAssessed  = 0;
  let feesApplied   = 0;
  let newlyDefaulted = 0;
  let assessClaimLost = 0;

  for (const row of (graceElapsedRows ?? []) as Array<{ id: string }>) {
    const outcome = await assessDunningFee(svc, row.id, { today: todayStr });
    if (outcome.kind === 'assessed') {
      feesAssessed++;
      if (outcome.feeAppliedCents > 0) feesApplied++;
      if (outcome.terminal) newlyDefaulted++;
    } else {
      assessClaimLost++;
    }
  }

  // ── 4b. Housekeeping: prune spent rate-limit hits ───────────────────
  //
  // rate_limit_hits (migration 0124) grows by one row per guarded request
  // and is only ever read over a rolling window, so anything past a day is
  // dead weight. It rides along with the daily run rather than taking a
  // fourth Vercel cron entry: it needs no schedule of its own, and a
  // separate cron for one DELETE would be noise in vercel.json.
  //
  // Non-fatal by construction — this job's purpose is collecting money,
  // and a failed prune must not colour the run's outcome. It is reported
  // in the summary so a silently-failing prune is visible in cron_runs
  // rather than only in the table size.
  let rateLimitRowsPruned: number | null = null;
  try {
    const { data, error } = await svc.rpc('delete_expired_rate_limit_hits', { p_older_than_secs: 86400 });
    if (error) {
      console.warn('[cron/collect-instalments] rate-limit prune failed (non-fatal)', error.message);
    } else {
      rateLimitRowsPruned = typeof data === 'number' ? data : null;
    }
  } catch (err) {
    // Catches the THROW as well as the returned error. "Non-fatal by
    // construction" has to mean it, or a job whose purpose is collecting
    // money dies on a housekeeping DELETE.
    console.warn('[cron/collect-instalments] rate-limit prune threw (non-fatal)',
      err instanceof Error ? err.message : String(err));
  }

  // ── 6. Sweep stuck 'processing' claims (audit A-13) ─────────────────
  //
  // Two tiers, and the split is the whole design — see
  // lib/payments/sweepStuckProcessing.ts. Rows that never reached the
  // provider are reverted; rows that may have a charge in flight are
  // reported for a human, because this Peach client cannot ask whether the
  // charge landed and guessing costs a customer a double payment either way.
  //
  // Non-fatal, like the prune above: this job's purpose is collecting money,
  // and a sweep that throws must not take the collection run down with it.
  // The summary carries the counts so a sweep that stops working, or one
  // whose reconciliation queue is growing, is visible in cron_runs rather
  // than only in the logs.
  let sweep: SweepSummary | null = null;
  try {
    sweep = await sweepStuckProcessing(svc, { now: startedAt });
    if (sweep.needs_reconciliation > 0) {
      console.error(
        '[cron/collect-instalments] ALERT payments awaiting manual reconciliation',
        { count: sweep.needs_reconciliation, ids: sweep.needs_reconciliation_ids },
      );
    }
  } catch (err) {
    console.error('[cron/collect-instalments] stuck-processing sweep threw (non-fatal)',
      err instanceof Error ? err.message : String(err));
  }

  const finishedAt = new Date();
  const summary = {
    started_at:            startedAt.toISOString(),
    finished_at:           finishedAt.toISOString(),
    eligible_count:        due.length,
    charged_count:         charged,
    claim_lost_count:      claimLost,
    transport_errors:      transportErrors,
    transport_error_ids:   transportErrorIds,
    grace_elapsed_count:   (graceElapsedRows ?? []).length,
    fees_assessed_count:   feesAssessed,
    fees_applied_count:    feesApplied,
    newly_defaulted_count: newlyDefaulted,
    assess_claim_lost_count: assessClaimLost,
    rate_limit_rows_pruned:  rateLimitRowsPruned,
    stuck_scanned:                sweep?.scanned ?? null,
    stuck_reverted:               sweep?.reverted ?? null,
    stuck_covered_reverted:       sweep?.covered_reverted ?? null,
    stuck_skipped_resumable:      sweep?.skipped_resumable ?? null,
    stuck_needs_reconciliation:   sweep?.needs_reconciliation ?? null,
    stuck_unrestorable:           sweep?.unrestorable ?? null,
  };

  // ── 5. Record the run for observability. A cron that silently stops
  //       running is a money-not-collected disaster — the admin portal
  //       can query cron_runs to show "last run at" per job.
  const { error: recordErr } = await svc.from('cron_runs').insert({
    job_name:    'collect-instalments',
    started_at:  startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    summary,
  });
  if (recordErr) {
    console.error('[cron/collect-instalments] failed to record run', recordErr);
  }

  console.log('[cron/collect-instalments] run summary', summary);

  return NextResponse.json({ ok: true, ...summary });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
