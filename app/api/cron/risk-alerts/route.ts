import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import {
  sendRiskDigest,
  type RiskNotificationClaim,
} from '@/lib/risk/notify';

// ─── The risk digest sender ─────────────────────────────────────────────
//
// Every fifteen minutes: claim everything an operator has not been told
// about, and email it to the platform's admin address.
//
// ─── WHY THIS IS A CRON AND NOT PART OF THE DECISION ────────────────────
//
// `evaluateRisk` runs on the hot path of signup, checkout, plan acceptance
// and payout release. Sending mail from there would put a network call with
// an 8-second timeout in front of a customer's payment, and it would send
// one email per finding — which for a ring working through a list of leaked
// SA IDs is four hundred emails in ten minutes, the fifth of which is
// already in a folder nobody reads.
//
// Nothing waits on this job. Every decision it reports has ALREADY been
// enforced: the ring was refused, the plan was held, the payout was
// stopped. The email exists to get a human to look, so a quarter-hour is
// not a risk — and the batching is what keeps the channel readable enough
// to be worth having.
//
// ─── EXACTLY ONCE ───────────────────────────────────────────────────────
//
// 0143's `claim_risk_notifications` stamps and returns in one statement, so
// two overlapping runs cannot both send the same batch. On an outright send
// failure the claim is released, putting the batch back in the next digest
// rather than losing it.

export const dynamic = 'force-dynamic';

const REQUIRE_CRON_SECRET = true;

/** Bounds on one digest. A ring can generate thousands of decisions in a
 *  window; an email listing all of them is unreadable and would blow the
 *  provider's size limit. The counts in the body still reflect the whole
 *  batch, and /admin/risk has the rest. */
const MAX_REVIEWS = 100;
const MAX_EVENTS  = 200;

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (REQUIRE_CRON_SECRET) {
    if (!secret) {
      console.error('[cron/risk-alerts] CRON_SECRET is not set — refusing to run.');
      return NextResponse.json({ error: 'Cron secret not configured.' }, { status: 500 });
    }
    const expected    = `Bearer ${secret}`;
    const receivedHdr = req.headers.get('authorization') ?? '';
    const expectedBuf = Buffer.from(expected, 'utf8');
    const receivedBuf = Buffer.from(receivedHdr, 'utf8');
    // Length first: timingSafeEqual throws on a length mismatch.
    if (receivedBuf.length !== expectedBuf.length) return unauthorized();
    if (!crypto.timingSafeEqual(receivedBuf, expectedBuf)) return unauthorized();
  }

  const startedAt = new Date();
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await svc.rpc('claim_risk_notifications', {
    p_max_reviews: MAX_REVIEWS,
    p_max_events:  MAX_EVENTS,
  });

  if (error || !data) {
    console.error('[cron/risk-alerts] claim failed', error);
    return NextResponse.json({ error: error?.message ?? 'claim returned nothing' }, { status: 500 });
  }

  const payload = data as Record<string, unknown>;
  const claim: RiskNotificationClaim = {
    reviews:  asArray(payload.reviews),
    events:   asArray(payload.events),
    switches: asArray(payload.switches),
    budgets:  asArray(payload.budgets),
  };

  const outcome = await sendRiskDigest(claim);

  // ── Put a failed batch back ──────────────────────────────────────────
  //
  // The claim stamped these rows before the send, which is the safer of the
  // two orderings (see 0143's header): a crash loses one digest rather than
  // duplicating pages. An outright send failure is the case we CAN recover,
  // so recover it — otherwise a transient Resend outage silently swallows
  // the one email that mattered.
  if (!outcome.sent && outcome.reason === 'send_failed') {
    const { error: releaseErr } = await svc.rpc('release_risk_notifications', {
      p_review_ids: claim.reviews.map((r) => r.id),
      p_event_ids:  claim.events.map((e) => e.id),
    });
    if (releaseErr) {
      console.error('[cron/risk-alerts] ALERT release failed — this batch will not be re-sent', releaseErr);
    }
  }

  const finishedAt = new Date();
  const summary = {
    started_at:  startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    reviews:   claim.reviews.length,
    decisions: claim.events.length,
    switches_engaged: claim.switches.length,
    sent:      outcome.sent,
    severity:  outcome.sent ? outcome.severity : null,
    reason:    outcome.sent ? null : outcome.reason,
  };

  // Recorded on every run, including the quiet ones. "The risk digest ran
  // and had nothing to say" and "the risk digest has not run since Tuesday"
  // look identical from a mailbox, and only one of them is fine.
  await svc.from('cron_runs').insert({
    job_name:    'risk-alerts',
    started_at:  summary.started_at,
    finished_at: summary.finished_at,
    summary,
  });

  return NextResponse.json(summary);
}

export async function GET(req: NextRequest)  { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
