import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import {
  getAccessToken,
  startGmailWatch,
  type GmailAccount,
} from '@/lib/gmail/gmailClient';
import { sweepAllThreadsForAccount } from '@/lib/gmail/replyIngest';

// ─── /api/cron/crm-reply-poll — Gmail reply safety-net + renewal ─────
//
// Since 0072 this is DOWNGRADED from every-15-min primary poller to a
// daily safety-net sweep. Gmail push (Pub/Sub → /api/crm/gmail/push)
// is the primary channel; this cron:
//   1. Sweeps every connected account's tracked threads (idempotent)
//   2. Renews any Gmail watch expiring in the next 24 h
//
// Same CRON_SECRET / timing-safe Authorization: Bearer pattern.

export const dynamic = 'force-dynamic';
const REQUIRE_CRON_SECRET = true;

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (REQUIRE_CRON_SECRET) {
    if (!secret) {
      console.error('[cron/crm-reply-poll] CRON_SECRET not set — refusing to run.');
      return NextResponse.json({ error: 'Cron secret not configured.' }, { status: 500 });
    }
    const expected = `Bearer ${secret}`;
    const received = req.headers.get('authorization') ?? '';
    const eb = Buffer.from(expected, 'utf8');
    const rb = Buffer.from(received, 'utf8');
    if (rb.length !== eb.length || !crypto.timingSafeEqual(rb, eb)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const s = svc();

  const { data: accounts } = await s
    .from('crm_email_accounts')
    .select('*')
    .eq('status', 'connected');

  const summary = { accounts: 0, threads: 0, newReplies: 0, watchesRenewed: 0, errors: 0 };
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  const now = Date.now();
  const RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

  for (const raw of ((accounts ?? []) as GmailAccount[])) {
    summary.accounts++;

    const tokenRes = await getAccessToken({ userId: raw.user_id, accountId: raw.id });
    if ('error' in tokenRes) {
      summary.errors++;
      continue;
    }

    // ── Sweep tracked threads (safety-net) ────────────────────────
    try {
      const sweep = await sweepAllThreadsForAccount(
        { id: raw.id, user_id: raw.user_id, gmail_address: raw.gmail_address },
        tokenRes.accessToken,
      );
      summary.threads    += sweep.threads;
      summary.newReplies += sweep.newReplies;
      summary.errors     += sweep.errors;
    } catch (err) {
      console.warn('[cron/crm-reply-poll] sweep failed', err);
      summary.errors++;
    }

    // ── Renew Gmail watch if within the renewal window ───────────
    const expiresAt = raw.watch_expires_at ? new Date(raw.watch_expires_at).getTime() : null;
    const needsRenewal = topic && (
      expiresAt == null ||
      expiresAt - now < RENEW_WINDOW_MS
    );
    if (needsRenewal) {
      try {
        const w = await startGmailWatch(tokenRes.accessToken, topic);
        const newExp = w.expiration ? new Date(Number(w.expiration)).toISOString() : null;
        await s.from('crm_email_accounts').update({
          last_history_id:  raw.last_history_id ?? w.historyId,
          watch_expires_at: newExp,
        }).eq('id', raw.id);
        summary.watchesRenewed++;
      } catch (err) {
        console.warn('[cron/crm-reply-poll] watch renew failed', err);
        summary.errors++;
      }
    }

    await s.from('crm_email_accounts')
      .update({ last_polled_at: new Date().toISOString() })
      .eq('id', raw.id);
  }

  return NextResponse.json({ ok: true, ...summary });
}

export async function GET(req: NextRequest)  { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
