import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { attemptChargeInstalment } from '@/lib/payments/chargeInstalment';

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

  const finishedAt = new Date();
  const summary = {
    started_at:          startedAt.toISOString(),
    finished_at:         finishedAt.toISOString(),
    eligible_count:      due.length,
    charged_count:       charged,
    claim_lost_count:    claimLost,
    transport_errors:    transportErrors,
    transport_error_ids: transportErrorIds,
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
