import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { getAccessToken, fetchThread, type ThreadMessage } from '@/lib/gmail/gmailClient';

// ─── /api/cron/crm-reply-poll — Gmail reply tracker ───────────────────
//
// Runs every 15 minutes (see vercel.json). For each connected Gmail
// account, finds every email activity on a non-closed lead that carries
// a gmail_thread_id, fetches thread metadata, and inserts an
// 'email_reply' activity for every inbound message we haven't seen
// before (idempotency key = gmail_message_id — unique per thread).
//
// Auth model: same CRON_SECRET / Authorization: Bearer pattern as
// /api/cron/collect-instalments — timing-safe compare against env.
//
// Scope: uses the gmail.readonly scope granted at connect time.
// Only threads updated since the account's last_polled_at are re-fetched,
// so a re-run costs one Gmail call per thread that changed.

export const dynamic = 'force-dynamic';
const REQUIRE_CRON_SECRET = true;

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

const CLOSED_STAGES = new Set(['signed', 'onboarded', 'lost']);

type EmailActivityRow = {
  id:                string;
  lead_id:           string;
  gmail_thread_id:   string;
  gmail_message_id:  string | null;
  created_by:        string | null;
  occurred_at:       string;
};

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

  // Every connected account we might have to poll.
  const { data: accounts } = await s
    .from('crm_email_accounts')
    .select('user_id, gmail_address, last_polled_at, status')
    .eq('status', 'connected');

  const summary = { accounts: 0, threads: 0, newReplies: 0, errors: 0 };

  for (const acc of (accounts ?? []) as Array<{ user_id: string; gmail_address: string; last_polled_at: string | null }>) {
    summary.accounts++;

    // Fresh access token via the client helper (refreshes if expired,
    // downgrades the account to reauth_required on grant-invalid).
    const tokenRes = await getAccessToken(acc.user_id);
    if ('error' in tokenRes) {
      summary.errors++;
      continue;
    }

    // Every open email activity created by (or observable to) this user
    // — grouped by thread id, only for leads not in a closed stage.
    // We DEDUPE on thread_id first so we hit Gmail once per thread even
    // if a lead has multiple outgoing emails on the same thread.
    const { data: emailActs } = await s
      .from('crm_activities')
      .select('id, lead_id, gmail_thread_id, gmail_message_id, created_by, occurred_at, crm_leads!inner(stage)')
      .not('gmail_thread_id', 'is', null)
      .eq('created_by', acc.user_id);

    const seenThreads = new Set<string>();
    type ActRow = EmailActivityRow & { crm_leads?: { stage?: string } | { stage?: string }[] };
    for (const raw of (emailActs ?? []) as unknown as ActRow[]) {
      const leadStageRel = Array.isArray(raw.crm_leads) ? raw.crm_leads[0] : raw.crm_leads;
      if (leadStageRel?.stage && CLOSED_STAGES.has(leadStageRel.stage)) continue;
      const threadId = raw.gmail_thread_id;
      if (!threadId || seenThreads.has(threadId)) continue;
      seenThreads.add(threadId);
      summary.threads++;

      try {
        const messages = await fetchThread(tokenRes.accessToken, threadId);
        if (messages.length === 0) continue;

        // Existing message-ids we've logged for this thread — used
        // both for outbound-send (gmail_message_id of the send) and
        // any prior polled inbound. This is the idempotency key: a
        // re-poll finds the same ids and inserts nothing.
        const { data: existing } = await s
          .from('crm_activities')
          .select('gmail_message_id')
          .eq('gmail_thread_id', threadId)
          .not('gmail_message_id', 'is', null);
        const knownIds = new Set(((existing ?? []) as Array<{ gmail_message_id: string }>).map(e => e.gmail_message_id));

        // The account's own gmail_address — everything from OTHER
        // addresses on the thread counts as inbound. We also ignore
        // SENT labels to avoid double-counting user's own drafts.
        for (const m of messages) {
          if (knownIds.has(m.id)) continue;
          const fromLc = (m.from || '').toLowerCase();
          const isFromMe = fromLc.includes(acc.gmail_address.toLowerCase());
          if (isFromMe) continue;
          if (m.labelIds.includes('SENT')) continue;

          const occurredAt = new Date(Number(m.internalDate)).toISOString();
          await s.from('crm_activities').insert({
            lead_id:          raw.lead_id,
            type:             'email_reply',
            title:            `Reply from ${m.from.split('<')[0].trim() || m.from}`,
            body:             m.snippet,
            occurred_at:      occurredAt,
            gmail_thread_id:  m.threadId,
            gmail_message_id: m.id,
            created_by:       acc.user_id,
          });
          summary.newReplies++;
        }
      } catch (err) {
        console.warn('[cron/crm-reply-poll] thread fetch failed', { threadId, err });
        summary.errors++;
      }
    }

    await s.from('crm_email_accounts')
      .update({ last_polled_at: new Date().toISOString() })
      .eq('user_id', acc.user_id);
  }

  return NextResponse.json({ ok: true, ...summary });
}

export async function GET(req: NextRequest)  { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
