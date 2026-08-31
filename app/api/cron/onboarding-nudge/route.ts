import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { currentFlags } from '@/lib/featureFlags';
import { resolveNudgeTarget, type ClaimedNudgeRow } from '@/lib/onboarding/nudgeCohort';
import { sendOnboardingNudge } from '@/lib/email/templates/onboardingNudge';

// ─── Abandoned-onboarding nudge cron ────────────────────────────────────
//
// A patient who confirms their email and stops is never contacted again.
// The resume path works — log in and /onboarding forwards to the first
// unfinished step — but nothing brings them back to log in. This sends at
// most two emails: one once they have been idle a few minutes, one a day
// later.
//
// ─── WHY A CRON RATHER THAN A SCHEDULED SEND ────────────────────────────
//
// Resend can schedule a send minutes into the future, which sounds neater
// than polling. It is worse here, because it commits to the email before
// we know whether it is still true: we would have to cancel reliably the
// moment the patient finishes, and a missed cancellation means emailing
// "you didn't finish your application" to somebody who just did. In a
// credit product that is an expensive kind of wrong.
//
// A cron re-reads state at send time, so that failure mode does not exist.
// The interval therefore only affects PRECISION, never correctness — if
// the deployment plan will not run this every five minutes, a longer
// interval still works and the nudge simply lands later.
//
// Vercel sends cron requests as GET with an Authorization: Bearer
// <CRON_SECRET> header. POST is supported so an operator can trigger a run
// by hand, exactly as collect-instalments does.

export const dynamic = 'force-dynamic';

const REQUIRE_CRON_SECRET = true;

/** Idle time before the first nudge. */
const STALE_MINUTES = 5;
/** Gap between the first nudge and the final one. */
const SECOND_AFTER_HOURS = 24;
/**
 * Per-run cap. At a five-minute cadence this is far more headroom than the
 * funnel produces; it exists so that a backlog — the first run after a
 * deploy, or after an outage — cannot turn into one enormous mail burst.
 */
const BATCH_LIMIT = 200;

async function handle(req: NextRequest): Promise<NextResponse> {
  // ── 1. Auth ───────────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  if (REQUIRE_CRON_SECRET) {
    if (!secret) {
      console.error('[cron/onboarding-nudge] CRON_SECRET is not set — refusing to run.');
      return NextResponse.json({ error: 'Cron secret not configured.' }, { status: 500 });
    }
    // Constant-time compare, same shape as collect-instalments: the length
    // check keeps a mismatched-size header from throwing instead of
    // cleanly rejecting.
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
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // ── 2. Claim ──────────────────────────────────────────────────────────
  //
  // One statement selects the due patients and counts the nudge, so two
  // overlapping runs cannot both send to the same person. Claim-then-send
  // means a failed send loses that nudge rather than repeating it, which
  // is the right way round for this email.
  const { data: claimed, error: claimErr } = await svc.rpc('claim_onboarding_nudges', {
    p_stale_minutes:      STALE_MINUTES,
    p_second_after_hours: SECOND_AFTER_HOURS,
    p_limit:              BATCH_LIMIT,
  });

  if (claimErr) {
    // ── The migration has not been applied yet ──────────────────────────
    //
    // Code and migrations ship in the same PR, but they do not go live at
    // the same instant: Vercel deploys on merge, and 0120 is applied by
    // hand. In that window the function does not exist, and PostgREST
    // answers PGRST202.
    //
    // Treated as "nothing to do" rather than an error, because the
    // alternative is a 500 and an error log every five minutes — 288 a
    // day — for a state that is expected, temporary, and not a fault. The
    // run is still recorded in cron_runs, so the gap is visible to anyone
    // looking, and it says so out loud once per run at info level.
    const notDeployedYet =
      claimErr.code === 'PGRST202' ||
      /could not find the function/i.test(claimErr.message ?? '');

    if (notDeployedYet) {
      console.log('[cron/onboarding-nudge] claim_onboarding_nudges not present — migration 0120 not applied yet; skipping');
      await svc.from('cron_runs').insert({
        job_name:    'onboarding-nudge',
        started_at:  startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        summary:     { skipped: 'migration_0120_not_applied' },
      });
      return NextResponse.json({ ok: true, skipped: 'migration_0120_not_applied' });
    }

    console.error('[cron/onboarding-nudge] claim failed', claimErr.message);
    return NextResponse.json({ error: 'Claim failed', detail: claimErr.message }, { status: 500 });
  }

  const rows: ClaimedNudgeRow[] = Array.isArray(claimed) ? claimed : [];
  const flags = currentFlags();

  let sent = 0;
  let failed = 0;
  let alreadyDone = 0;
  let noEmail = 0;

  // ── 3. Send ───────────────────────────────────────────────────────────
  //
  // Sequential, not Promise.all: this is a low-volume background job and a
  // burst of parallel sends buys nothing except a rate-limit risk with
  // Resend. One slow send delays the batch, which nothing depends on.
  for (const row of rows) {
    if (!row.email) {
      // profiles.email is NOT NULL, so this is defence rather than a real
      // branch — but a blank string would make Resend reject the whole
      // send and it is cheaper to skip than to explain in a log later.
      noEmail += 1;
      continue;
    }

    const target = resolveNudgeTarget(row, flags);
    if (!target) {
      // Finished in the window between the claim and now. The nudge is
      // already counted against them, which is fine: they will never be
      // in the cohort again.
      alreadyDone += 1;
      continue;
    }

    const result = await sendOnboardingNudge({
      to:          target.email,
      firstName:   target.firstName,
      stepLabel:   target.stepLabel,
      nudgeNumber: target.nudgeNumber,
    });

    if (result.ok) {
      sent += 1;
    } else {
      failed += 1;
      // No user id in the log line — this is a mail failure, and the id
      // is recoverable from onboarding_nudge_last_sent_at if anyone needs
      // to reconcile.
      console.warn('[cron/onboarding-nudge] send failed', result.error);
    }
  }

  // ── 4. Record the run ─────────────────────────────────────────────────
  const finishedAt = new Date();
  const summary = {
    claimed:      rows.length,
    sent,
    failed,
    already_done: alreadyDone,
    no_email:     noEmail,
    stale_minutes:      STALE_MINUTES,
    second_after_hours: SECOND_AFTER_HOURS,
  };

  const { error: recordErr } = await svc.from('cron_runs').insert({
    job_name:    'onboarding-nudge',
    started_at:  startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    summary,
  });
  if (recordErr) {
    console.error('[cron/onboarding-nudge] failed to record run', recordErr);
  }

  // Only log a summary line when something happened. At a five-minute
  // cadence an unconditional log is 288 near-identical lines a day, which
  // buries the runs that did something.
  if (rows.length > 0) {
    console.log('[cron/onboarding-nudge] run summary', summary);
  }

  return NextResponse.json({ ok: true, ...summary });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
