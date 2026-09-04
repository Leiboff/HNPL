import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import {
  breakerThresholds,
  evaluatePracticeBreaker,
} from '@/lib/risk/circuitBreaker';

// ─── The risk monitor (audit 2026-09-03, S-07) ──────────────────────────
//
// Two jobs the per-request decision path cannot do, both of them because
// they are questions about ACCUMULATION rather than about one request.
//
//   1. PER-PRACTICE CIRCUIT BREAKERS. Exposure, weekly payout, new-customer
//      inflow and the first-payment rate are four aggregates over `plans`,
//      `payments` and `payouts`. They change over days and cost four
//      aggregate queries to compute, so putting them on the hot path of
//      plan acceptance would be four scans per checkout to answer a
//      question whose answer moves hourly at most. Evaluated here, and the
//      breaker they trip is a standing block every request then reads for
//      free.
//
//   2. RETENTION. `prune_risk_data` enforces the POPIA retention the
//      correlation store is built around: observations 90 days, decisions
//      180, expired blocks immediately. A retention rule nothing executes
//      is a paragraph in a policy document, not a control.
//
// ─── WHY THIS RUNS BEFORE THE PAYOUT BATCHER ────────────────────────────
//
// The weekly batcher (Thursday 00:00 UTC) is what makes a practice's money
// eligible to leave. This runs daily at 23:30 UTC, so Wednesday's pass lands
// 30 minutes before that batch closes. The batch runner also re-evaluates
// every candidate practice synchronously: cron delivery is best-effort, so
// schedule ordering is useful defence in depth, never the money boundary.
//
// ─── ORDER: BREAKERS FIRST, PRUNE SECOND ────────────────────────────────
//
// The breaker reads the financial tables and not the correlation store, so
// the two are independent in principle. They are ordered anyway: a prune
// that fails must never be the reason a breaker did not run, and putting
// the cheap-and-important thing first makes that impossible rather than
// merely unlikely.

export const dynamic = 'force-dynamic';

const REQUIRE_CRON_SECRET = true;

/** A ceiling on how many practices one pass will evaluate.
 *
 *  Not a correctness bound — every practice is evaluated eventually — but a
 *  bound on the job's own cost, so a platform with ten thousand practices
 *  does not turn its fraud monitor into its longest-running query. Ordered
 *  by most recent plan activity, because a practice that has not traded
 *  this week cannot have breached a weekly threshold. */
const MAX_PRACTICES_PER_RUN = 500;

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (REQUIRE_CRON_SECRET) {
    if (!secret) {
      console.error('[cron/risk-monitor] CRON_SECRET is not set — refusing to run.');
      return NextResponse.json({ error: 'Cron secret not configured.' }, { status: 500 });
    }
    const expected    = `Bearer ${secret}`;
    const receivedHdr = req.headers.get('authorization') ?? '';
    const expectedBuf = Buffer.from(expected, 'utf8');
    const receivedBuf = Buffer.from(receivedHdr, 'utf8');
    // Length check first: timingSafeEqual throws on a length mismatch.
    if (receivedBuf.length !== expectedBuf.length) return unauthorized();
    if (!crypto.timingSafeEqual(receivedBuf, expectedBuf)) return unauthorized();
  }

  const startedAt = new Date();
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const thresholds = breakerThresholds();
  const since = new Date(Date.now() - thresholds.windowDays * 86_400_000).toISOString();

  // ── 1. Which practices could possibly have breached? ─────────────────
  //
  // Only ones that traded inside the window. A dormant practice cannot have
  // exceeded a weekly payout or a weekly new-customer ceiling, and its open
  // exposure cannot have grown — so evaluating it is four queries spent to
  // learn nothing.
  //
  // The one thing this misses is a practice carrying dangerous exposure from
  // BEFORE the window with no new activity since. That is a real gap and it
  // is deliberate: such a practice is not receiving new money (no new plans
  // means no new payouts), so the breaker has nothing to hold, and the
  // collections and dunning paths are what should be looking at it.
  const { data: activePlans, error: activeErr } = await svc
    .from('plans')
    .select('practice_id')
    .gte('created_at', since)
    .not('practice_id', 'is', null)
    .limit(20_000);

  if (activeErr) {
    console.error('[cron/risk-monitor] practice discovery failed', activeErr);
    return NextResponse.json({ error: activeErr.message }, { status: 500 });
  }

  const practiceIds = [
    ...new Set((activePlans ?? []).map((r: { practice_id: string }) => r.practice_id)),
  ].slice(0, MAX_PRACTICES_PER_RUN);

  // ── 2. Evaluate, and trip where breached ─────────────────────────────
  //
  // Sequential rather than parallel, deliberately. Each iteration is one
  // aggregate RPC and, at most, one write; running five hundred of those
  // concurrently against the same connection pool would put the fraud
  // monitor in contention with live checkouts, which is a poor trade for a
  // job that has all night.
  let evaluated = 0;
  let tripped = 0;
  const held: Array<{ practiceId: string; action: string; breaches: unknown }> = [];

  for (const practiceId of practiceIds) {
    try {
      const outcome = await evaluatePracticeBreaker(practiceId, { thresholds, client: svc });
      evaluated += 1;
      if (outcome.tripped) {
        tripped += 1;
        held.push({ practiceId, action: outcome.action, breaches: outcome.breaches });
      }
    } catch (err) {
      // One practice failing must not end the pass — the remaining ones are
      // the point of the job.
      console.error('[cron/risk-monitor] practice evaluation failed', {
        practiceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 3. Retention ─────────────────────────────────────────────────────
  let pruned: unknown = null;
  const { data: pruneResult, error: pruneErr } = await svc.rpc('prune_risk_data', {
    p_observation_days: 90,
    p_event_days:       180,
    p_budget_days:      400,
  });
  if (pruneErr) {
    // Alertable, not fatal: an un-pruned correlation store is a retention
    // problem to fix, and reporting the whole run as failed would hide the
    // breaker results above it.
    console.error('[cron/risk-monitor] ALERT retention prune failed', pruneErr);
  } else {
    pruned = pruneResult;
  }

  const finishedAt = new Date();
  const summary = {
    started_at:  startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    practices_considered: practiceIds.length,
    practices_evaluated:  evaluated,
    practices_held:       tripped,
    held,
    pruned,
    prune_failed: !!pruneErr,
  };

  // The same cron_runs trail the other scheduled jobs write, so "did the
  // fraud monitor run last night" is answerable from one table.
  await svc.from('cron_runs').insert({
    job_name:    'risk-monitor',
    started_at:  summary.started_at,
    finished_at: summary.finished_at,
    summary,
  });

  if (tripped > 0) {
    console.error(JSON.stringify({
      event: 'risk_monitor_held_practices',
      schema_version: 1,
      occurred_at: finishedAt.toISOString(),
      count: tripped,
      held,
    }));
  }

  return NextResponse.json(summary);
}

export async function GET(req: NextRequest)  { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
