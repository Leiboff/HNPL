// Node runtime required — crypto.timingSafeEqual for the cron auth.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';

// ─── Daily referral housekeeping ────────────────────────────────────────────
//
// Calls prune_referral_invites() (migration 0145), which does two things in
// one sweep:
//
//   • EXPIRES a pending invitation past its thirty-day window;
//   • SCRUBS the invitee's name, address, phone and note off invitations that
//     are dead and past retention, keeping the referral row itself.
//
// ─── WHY THIS IS A JOB AND NOT A QUERY ──────────────────────────────────────
//
// The expiry half could be derived — lib/referrals/vocabulary.ts does derive
// it, so a screen never shows "pending" for something that plainly lapsed.
// The scrub cannot be. An address we no longer have a reason to hold is not
// made lawful by a view that declines to display it; the only thing that
// discharges the obligation is deleting the value.
//
// That is also why the two live in one function and one job. If they were
// separate, the visible half would be the one that got scheduled.
//
// ─── WHOSE INFORMATION THIS IS ──────────────────────────────────────────────
//
// The person being scrubbed is not a customer. They never signed up, never
// agreed to anything, and are in the database because somebody typed their
// address into a form. POPIA §14 makes retention the exception rather than
// the default, and a referral invitation that expired months ago has no
// exception left to stand on. See the retention section of 0145.
//
// ─── FAILURE POSTURE ────────────────────────────────────────────────────────
//
// A 500 on a genuine failure, because a retry may help and a sweep that
// silently stops running is the failure mode this whole design is guarding
// against. The counts go into cron_runs so "the scrub did nothing today" is
// answerable without a database session — which is how anyone would notice
// that it had stopped.

const REQUIRE_CRON_SECRET = true;

async function handle(req: NextRequest): Promise<NextResponse> {
  // ── Auth — identical posture to every other cron route ──────────────────
  const secret = process.env.CRON_SECRET;
  if (REQUIRE_CRON_SECRET) {
    if (!secret) {
      console.error('[cron/referral-maintenance] CRON_SECRET is not set — refusing to run.');
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

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // The default retention (90 days past the end of the invitation) lives in
  // the function's signature rather than here, so the number is reviewed
  // alongside the rule it implements rather than in a route handler.
  const { data, error } = await svc.rpc('prune_referral_invites');

  const finishedAt = new Date();

  if (error) {
    console.error('[cron/referral-maintenance] ALERT prune_referral_invites() failed', {
      message: error.message,
    });
    await svc.from('cron_runs').insert({
      job_name:    'referral-maintenance',
      started_at:  startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      summary:     { ok: false, error: error.message },
    });
    return NextResponse.json({ ok: false, error: 'prune_failed' }, { status: 500 });
  }

  // The RPC returns a one-row table, which PostgREST hands back as an array.
  const row = Array.isArray(data) ? data[0] : data;
  const record = {
    ok:        true,
    expired:   Number(row?.expired_count  ?? 0),
    scrubbed:  Number(row?.scrubbed_count ?? 0),
  };

  const { error: recordErr } = await svc.from('cron_runs').insert({
    job_name:    'referral-maintenance',
    started_at:  startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    summary:     record,
  });
  if (recordErr) {
    console.error('[cron/referral-maintenance] failed to record run', recordErr);
  }

  console.log('[cron/referral-maintenance] done', record);
  return NextResponse.json(record);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

// POST so an operator can trigger a run by hand:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
//     https://<host>/api/cron/referral-maintenance
export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
