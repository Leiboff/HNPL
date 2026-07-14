import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import {
  getAccessToken,
  listHistoryFrom,
  fetchMessageMetadata,
  type GmailAccount,
} from '@/lib/gmail/gmailClient';
import {
  ingestOneMessage,
  sweepAllThreadsForAccount,
} from '@/lib/gmail/replyIngest';
import { verifyGoogleIdToken } from '@/lib/gmail/oidcVerify';

// ─── /api/crm/gmail/push — Cloud Pub/Sub push receiver ───────────────
//
// Real-time inbound-email notifications from Gmail via Cloud Pub/Sub.
// The Pub/Sub subscription is configured with OIDC auth — every push
// request carries a Google-signed JWT in Authorization: Bearer. We
// verify it before trusting the body.
//
// Handler must be idempotent (Pub/Sub retries on non-2xx); dedupe is
// enforced by the shared replyIngest module via gmail_message_id.

export const dynamic = 'force-dynamic';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

type PubSubMessageEnvelope = {
  message?: {
    data?:        string;                         // base64 JSON payload
    messageId?:   string;
    publishTime?: string;
    attributes?:  Record<string, string>;
  };
  subscription?: string;
};

type GmailPushPayload = {
  emailAddress?: string;
  historyId?:    number | string;
};

async function handle(req: NextRequest): Promise<NextResponse> {
  // ── 1. OIDC verify ──────────────────────────────────────────────
  const audience = process.env.GMAIL_PUSH_AUDIENCE;
  const saEmail  = process.env.GMAIL_PUSH_SA_EMAIL;
  if (!audience || !saEmail) {
    console.error('[gmail-push] GMAIL_PUSH_AUDIENCE / GMAIL_PUSH_SA_EMAIL not configured');
    return NextResponse.json({ error: 'push_not_configured' }, { status: 500 });
  }

  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return NextResponse.json({ error: 'missing_token' }, { status: 401 });
  const verify = await verifyGoogleIdToken(m[1], audience, saEmail);
  if (!verify.ok) {
    return NextResponse.json({ error: verify.reason }, { status: 401 });
  }

  // ── 2. Decode Pub/Sub envelope ──────────────────────────────────
  let envelope: PubSubMessageEnvelope;
  try {
    envelope = await req.json() as PubSubMessageEnvelope;
  } catch {
    return NextResponse.json({ error: 'bad_body' }, { status: 400 });
  }
  const dataB64 = envelope.message?.data;
  if (!dataB64) {
    // Pub/Sub sometimes sends empty pings — return 200 so it doesn't retry.
    return NextResponse.json({ ok: true, empty: true });
  }
  let payload: GmailPushPayload;
  try {
    const decoded = Buffer.from(dataB64, 'base64').toString('utf8');
    payload = JSON.parse(decoded) as GmailPushPayload;
  } catch {
    return NextResponse.json({ error: 'bad_payload' }, { status: 400 });
  }
  const email = (payload.emailAddress || '').toLowerCase();
  const newHistoryId = payload.historyId != null ? String(payload.historyId) : null;
  if (!email || !newHistoryId) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  // ── 3. Look up the account ──────────────────────────────────────
  const s = svc();
  const { data: acctRow } = await s
    .from('crm_email_accounts')
    .select('*')
    .ilike('gmail_address', email)
    .maybeSingle();
  const account = (acctRow ?? null) as GmailAccount | null;
  if (!account) {
    // No connection for this address — could be a race with a disconnect.
    return NextResponse.json({ ok: true, ignored: true });
  }
  if (account.status !== 'connected') {
    return NextResponse.json({ ok: true, skipped: 'not_connected' });
  }

  // ── 4. Fresh access token ───────────────────────────────────────
  const tokenRes = await getAccessToken({ userId: account.user_id, accountId: account.id });
  if ('error' in tokenRes) {
    return NextResponse.json({ ok: true, skipped: tokenRes.error });
  }
  const accessToken = tokenRes.accessToken;

  // ── 5. History pull ─────────────────────────────────────────────
  const stored = account.last_history_id;
  let inserted = 0;

  if (!stored) {
    // First push for this account — nothing to compare against.
    // Store the notified historyId as the cursor and sweep the account
    // once so we capture anything already sitting in the tracked threads.
    await sweepAllThreadsForAccount(
      { id: account.id, user_id: account.user_id, gmail_address: account.gmail_address },
      accessToken,
    );
    await s.from('crm_email_accounts')
      .update({ last_history_id: newHistoryId })
      .eq('id', account.id);
    return NextResponse.json({ ok: true, initialised: true });
  }

  const history = await listHistoryFrom(accessToken, stored);
  if (history.kind === 'expired') {
    // historyId aged past Google's window — fall back to full sweep
    // and reset the cursor.
    const sweep = await sweepAllThreadsForAccount(
      { id: account.id, user_id: account.user_id, gmail_address: account.gmail_address },
      accessToken,
    );
    inserted = sweep.newReplies;
    await s.from('crm_email_accounts')
      .update({ last_history_id: newHistoryId })
      .eq('id', account.id);
    return NextResponse.json({ ok: true, recovered: true, inserted });
  }

  for (const evt of history.messages) {
    const meta = await fetchMessageMetadata(accessToken, evt.message.id).catch(() => null);
    if (!meta) continue;
    if (!meta.labelIds.includes('INBOX')) continue;
    const verdict = await ingestOneMessage(
      { id: account.id, user_id: account.user_id, gmail_address: account.gmail_address },
      meta,
    );
    if (verdict === 'inserted') inserted++;
  }

  // Advance the cursor to the newer of (history response's latest,
  // notification's historyId).
  const advanceTo = history.newHistoryId && Number(history.newHistoryId) > Number(newHistoryId)
    ? history.newHistoryId
    : newHistoryId;
  await s.from('crm_email_accounts')
    .update({ last_history_id: advanceTo })
    .eq('id', account.id);

  return NextResponse.json({ ok: true, inserted });
}

export async function POST(req: NextRequest) { return handle(req); }
