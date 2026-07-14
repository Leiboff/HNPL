// ─── Shared reply-ingest logic ────────────────────────────────────
//
// Two callers share this code path:
//   1. /api/cron/crm-reply-poll (safety-net sweep, daily)
//   2. /api/crm/gmail/push       (real-time via Cloud Pub/Sub)
//
// Extracted here so idempotency + attribution + closed-lead filtering
// live in one place — the two entry-points differ only in HOW they
// obtain the candidate messages (fetchThread vs history.list).

import { createClient as createServiceClient } from '@supabase/supabase-js';
import { fetchThread, type ThreadMessage } from './gmailClient';

export const CLOSED_STAGES = new Set(['signed', 'onboarded', 'lost']);

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export type AccountForIngest = {
  id:            string;
  user_id:       string;
  gmail_address: string;
};

/**
 * Given a Gmail message on a thread we're tracking, decide whether it
 * is a new inbound reply we should log — and if so, insert the
 * crm_activities row. Dedupes on gmail_message_id (row-level).
 *
 * Return value used for reporting: 'inserted' | 'duplicate' |
 * 'from_self' | 'no_matching_thread' | 'lead_closed'.
 */
export async function ingestOneMessage(
  account: AccountForIngest,
  message: ThreadMessage,
): Promise<'inserted' | 'duplicate' | 'from_self' | 'no_matching_thread' | 'lead_closed'> {
  const s = svc();

  const fromLc = (message.from || '').toLowerCase();
  if (fromLc.includes(account.gmail_address.toLowerCase())) return 'from_self';
  if (message.labelIds.includes('SENT')) return 'from_self';

  // Find any activity on this thread (whether the outbound send from
  // this account or a prior polled inbound). The lead comes from that
  // activity — we don't accept messages on unrelated threads.
  const { data: matches } = await s
    .from('crm_activities')
    .select('id, lead_id, gmail_message_id, crm_leads!inner(stage)')
    .eq('gmail_thread_id', message.threadId);

  const rows = (matches ?? []) as unknown as Array<{
    id:               string;
    lead_id:          string;
    gmail_message_id: string | null;
    crm_leads?: { stage?: string } | Array<{ stage?: string }>;
  }>;
  if (rows.length === 0) return 'no_matching_thread';

  // Idempotency: any row already carrying this message id → duplicate.
  if (rows.some(r => r.gmail_message_id === message.id)) return 'duplicate';

  // Lead-closed filter: use the first matched row's lead stage. All
  // rows for a thread share a lead_id, so the stage is consistent.
  const stageRel = Array.isArray(rows[0].crm_leads) ? rows[0].crm_leads[0] : rows[0].crm_leads;
  if (stageRel?.stage && CLOSED_STAGES.has(stageRel.stage)) return 'lead_closed';

  const occurredAt = new Date(Number(message.internalDate)).toISOString();
  await s.from('crm_activities').insert({
    lead_id:          rows[0].lead_id,
    type:             'email_reply',
    title:            `Reply from ${message.from.split('<')[0].trim() || message.from}`,
    body:             message.snippet,
    occurred_at:      occurredAt,
    gmail_thread_id:  message.threadId,
    gmail_message_id: message.id,
    created_by:       account.user_id,
    sent_from:        account.gmail_address,
    // Since 0073: capture the raw From address and the RFC Message-Id
    // so a CRM-side reply can prefill "To:" and stamp In-Reply-To.
    reply_from:       extractEmailAddress(message.from),
    message_rfc_id:   message.rfcMessageId,
  });
  return 'inserted';
}

/**
 * Extract the bare email address from an RFC 5322 From header (e.g.
 * `"Alice Smith" <alice@example.com>` → `alice@example.com`).
 * Returns the input unchanged if no angle-bracketed address is found.
 */
export function extractEmailAddress(rawFrom: string): string {
  if (!rawFrom) return '';
  const m = rawFrom.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (m) return m[1].trim();
  const bare = rawFrom.trim();
  return /@/.test(bare) ? bare : rawFrom;
}

/**
 * Sweep every tracked thread for a single account (used by both the
 * safety-net poller and the push handler's "historyId expired"
 * fallback). Fetches thread-by-thread and delegates each message to
 * ingestOneMessage.
 */
export async function sweepAllThreadsForAccount(
  account: AccountForIngest,
  accessToken: string,
): Promise<{ threads: number; newReplies: number; errors: number }> {
  const s = svc();
  const { data: emailActs } = await s
    .from('crm_activities')
    .select('gmail_thread_id, crm_leads!inner(stage)')
    .not('gmail_thread_id', 'is', null)
    .eq('created_by', account.user_id);

  const rows = (emailActs ?? []) as unknown as Array<{
    gmail_thread_id: string;
    crm_leads?: { stage?: string } | Array<{ stage?: string }>;
  }>;

  const seenThreads = new Set<string>();
  const summary = { threads: 0, newReplies: 0, errors: 0 };

  for (const raw of rows) {
    const stageRel = Array.isArray(raw.crm_leads) ? raw.crm_leads[0] : raw.crm_leads;
    if (stageRel?.stage && CLOSED_STAGES.has(stageRel.stage)) continue;
    const threadId = raw.gmail_thread_id;
    if (!threadId || seenThreads.has(threadId)) continue;
    seenThreads.add(threadId);
    summary.threads++;

    try {
      const messages = await fetchThread(accessToken, threadId);
      for (const m of messages) {
        const verdict = await ingestOneMessage(account, m);
        if (verdict === 'inserted') summary.newReplies++;
      }
    } catch (err) {
      console.warn('[replyIngest] thread fetch failed', { threadId, err });
      summary.errors++;
    }
  }

  return summary;
}
