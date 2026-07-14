// ─── Gmail API — thin, dependency-free client ─────────────────────────
//
// We call the Gmail REST API directly via fetch — no @googleapis/gmail
// dep, no oauth2 SDK. Everything below is service-side; refresh tokens
// live in crm_email_accounts.refresh_token_enc (AES-256-GCM) and are
// decrypted only inside the getAccessToken() helper here.
//
// Since 0072 one user can connect multiple Gmail addresses. Account
// selection is by (user_id, id) or (user_id, gmail_address). Legacy
// callers that pass only userId get the user's most-recently-used
// account.

import { encryptToken, decryptToken } from '@/lib/crypto/tokenEncryption';
import { createClient as createServiceClient } from '@supabase/supabase-js';

// ── Configuration ────────────────────────────────────────────────────

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

export const OAUTH_ENDPOINT   = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT   = 'https://oauth2.googleapis.com/token';
export const REVOKE_ENDPOINT  = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_API_BASE   = 'https://gmail.googleapis.com/gmail/v1/users/me';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// ── OAuth start URL ──────────────────────────────────────────────────

export type AuthUrlArgs = {
  state:       string;
  redirectUri: string;
};

export function buildAuthUrl({ state, redirectUri }: AuthUrlArgs): string {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  if (!clientId) throw new Error('GMAIL_OAUTH_CLIENT_ID not set');
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         GMAIL_SCOPES.join(' '),
    access_type:   'offline',
    prompt:        'consent',       // force refresh_token issuance
    include_granted_scopes: 'true',
    state,
  });
  return `${OAUTH_ENDPOINT}?${params.toString()}`;
}

// ── Code → tokens ────────────────────────────────────────────────────

type TokenResponse = {
  access_token:   string;
  refresh_token?: string;
  expires_in:     number;
  scope:          string;
  token_type:     string;
  id_token?:      string;
};

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<TokenResponse> {
  const clientId     = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Gmail OAuth env not configured');

  const body = new URLSearchParams({
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gmail token exchange failed: ${res.status} ${errText.slice(0, 200)}`);
  }
  return await res.json() as TokenResponse;
}

// ── Refresh token → fresh access token ───────────────────────────────

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
  const clientId     = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Gmail OAuth env not configured');

  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'refresh_token',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gmail token refresh failed: ${res.status} ${errText.slice(0, 200)}`);
  }
  const parsed = await res.json() as TokenResponse;
  const expiresAt = new Date(Date.now() + (parsed.expires_in - 60) * 1000);
  return { accessToken: parsed.access_token, expiresAt };
}

// ── Get profile (email of the OAuth user) ────────────────────────────

export async function fetchGmailProfile(accessToken: string): Promise<{ emailAddress: string }> {
  const res = await fetch(`${GMAIL_API_BASE}/profile`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail profile fetch failed: ${res.status}`);
  return await res.json() as { emailAddress: string };
}

// ── Store / retrieve / revoke tokens ─────────────────────────────────

export async function saveGmailAccount(input: {
  userId:        string;
  gmailAddress:  string;
  refreshToken:  string;
  accessToken:   string;
  expiresAt:     Date;
}): Promise<{ error?: string; accountId?: string }> {
  const s = svc();
  const encRt = encryptToken(input.refreshToken);
  const { data, error } = await s.from('crm_email_accounts').upsert({
    user_id:             input.userId,
    gmail_address:       input.gmailAddress,
    refresh_token_enc:   encRt,
    access_token_cache:  input.accessToken,
    access_token_expiry: input.expiresAt.toISOString(),
    connected_at:        new Date().toISOString(),
    status:              'connected',
  }, { onConflict: 'user_id,gmail_address' })
    .select('id')
    .single();
  if (error) return { error: error.message };
  return { accountId: (data as { id: string } | null)?.id };
}

/**
 * Look up an account by explicit selector or by "most-recently-used"
 * fallback. Callers should prefer passing accountId; passing only
 * userId is legacy behaviour that picks last_used_at (or connected_at
 * if never used).
 */
type AccountSelector =
  | { userId: string; accountId: string }
  | { userId: string; gmailAddress: string }
  | { userId: string };

async function findAccount(sel: AccountSelector): Promise<GmailAccount | null> {
  const s = svc();
  let q = s.from('crm_email_accounts').select('*').eq('user_id', sel.userId);
  if ('accountId' in sel)      q = q.eq('id', sel.accountId);
  else if ('gmailAddress' in sel) q = q.ilike('gmail_address', sel.gmailAddress);
  else                             q = q.order('last_used_at', { ascending: false, nullsFirst: false })
                                        .order('connected_at', { ascending: false })
                                        .limit(1);
  const { data } = await q.maybeSingle();
  return (data ?? null) as GmailAccount | null;
}

export async function getAccessToken(
  sel: AccountSelector,
): Promise<{ accessToken: string; account: GmailAccount } | { error: string }> {
  const account = await findAccount(sel);
  if (!account) return { error: 'gmail_not_connected' };
  if (account.status !== 'connected') return { error: 'gmail_reauth_required' };

  const s = svc();

  // Cached access token still valid?
  const cachedExpiry = account.access_token_expiry ? new Date(account.access_token_expiry) : null;
  if (account.access_token_cache && cachedExpiry && cachedExpiry.getTime() - 30_000 > Date.now()) {
    return { accessToken: account.access_token_cache, account };
  }

  // Refresh.
  try {
    const decrypted = decryptToken(account.refresh_token_enc);
    const { accessToken, expiresAt } = await refreshAccessToken(decrypted.plaintext);

    // Self-heal: if the stored ciphertext opened under the legacy
    // SA-ID key, re-encrypt under TOKEN_ENCRYPTION_KEY now.
    const patch: Record<string, unknown> = {
      access_token_cache:  accessToken,
      access_token_expiry: expiresAt.toISOString(),
    };
    if (decrypted.usedLegacyKey) {
      try {
        patch.refresh_token_enc = encryptToken(decrypted.plaintext);
      } catch (reEncErr) {
        console.warn('[getAccessToken] re-encrypt under primary key failed', reEncErr);
      }
    }

    await s.from('crm_email_accounts').update(patch).eq('id', account.id);
    return { accessToken, account: { ...account, ...patch } as GmailAccount };
  } catch (err) {
    console.warn('[getAccessToken] refresh failed', err);
    await s.from('crm_email_accounts').update({ status: 'reauth_required' }).eq('id', account.id);
    return { error: 'gmail_reauth_required' };
  }
}

/**
 * Revoke a specific account. Best-effort: proceeds to delete the row
 * even if Google returns a non-2xx (already-revoked, expired token).
 * Also calls users.stop (best-effort) if a watch was active.
 */
export async function revokeGmailAccountById(accountId: string): Promise<{ error?: string }> {
  const s = svc();
  const { data } = await s
    .from('crm_email_accounts')
    .select('id, user_id, gmail_address, refresh_token_enc, watch_expires_at')
    .eq('id', accountId)
    .maybeSingle();
  if (!data) return { error: 'not_found' };

  // Try to stop the Gmail push watch first — needs a live access token.
  if (data.watch_expires_at) {
    try {
      const tokenRes = await getAccessToken({ userId: data.user_id as string, accountId });
      if ('accessToken' in tokenRes) {
        await stopGmailWatch(tokenRes.accessToken).catch(() => { /* best-effort */ });
      }
    } catch { /* best-effort */ }
  }

  // Revoke the refresh token at Google. Best-effort — proceed on error.
  if (data.refresh_token_enc) {
    try {
      const { plaintext } = decryptToken(data.refresh_token_enc as string);
      await fetch(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ token: plaintext }),
      }).catch(() => { /* best-effort */ });
    } catch { /* corrupt token — proceed to delete */ }
  }

  const { error } = await s.from('crm_email_accounts').delete().eq('id', accountId);
  if (error) return { error: error.message };
  return {};
}

/**
 * User-initiated disconnect. Removes ALL of a user's connected accounts
 * if no selector is supplied, or the specific account otherwise.
 */
export async function revokeGmailAccount(
  userId: string,
  opts?: { accountId?: string; gmailAddress?: string },
): Promise<{ error?: string; removed: number }> {
  const s = svc();
  let q = s.from('crm_email_accounts').select('id').eq('user_id', userId);
  if (opts?.accountId)       q = q.eq('id', opts.accountId);
  else if (opts?.gmailAddress) q = q.ilike('gmail_address', opts.gmailAddress);
  const { data } = await q;
  let removed = 0;
  for (const row of ((data ?? []) as Array<{ id: string }>)) {
    const r = await revokeGmailAccountById(row.id);
    if (!r.error) removed++;
  }
  return { removed };
}

export type GmailAccount = {
  id:                  string;
  user_id:             string;
  gmail_address:       string;
  refresh_token_enc:   string;
  access_token_cache:  string | null;
  access_token_expiry: string | null;
  connected_at:        string;
  last_polled_at:      string | null;
  last_used_at:        string | null;
  last_history_id:     string | null;
  watch_expires_at:    string | null;
  status:              'connected' | 'reauth_required' | 'revoked';
};

// ── Send + list threads ──────────────────────────────────────────────

export type SendArgs = {
  accessToken: string;
  from:        string;
  fromName:    string;
  to:          string;
  subject:     string;
  bodyText:    string;
  bodyHtml?:   string;
  /** Include on reply-mode sends so Gmail places the message in the
   *  same thread. Without this Gmail may (and often does) create a
   *  new thread even when In-Reply-To is set. */
  threadId?:   string;
  /** RFC 822 Message-Id of the message being replied to. Stamped
   *  into the In-Reply-To header and appended to References. */
  inReplyTo?:  string;
  /** Prior References value on the message being replied to. When
   *  present, the outbound References becomes `${prior} ${inReplyTo}`.
   *  When absent, References = inReplyTo alone. */
  references?: string;
};

/**
 * Build an RFC-822 message and send via Gmail's users.messages.send.
 * If bodyHtml is supplied, the message is multipart/alternative with
 * text + html parts. threadId/inReplyTo/references are optional and
 * used only in reply mode. Returns { messageId, threadId } from Gmail.
 */
export async function sendGmail(args: SendArgs): Promise<{ messageId: string; threadId: string }> {
  const subject = args.subject.replace(/[\r\n]/g, ' ');
  const commonHeaders = [
    `From: "${args.fromName}" <${args.from}>`,
    `To: ${args.to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  ];
  if (args.inReplyTo) {
    commonHeaders.push(`In-Reply-To: ${args.inReplyTo}`);
    const refs = args.references
      ? `${args.references.trim()} ${args.inReplyTo}`
      : args.inReplyTo;
    commonHeaders.push(`References: ${refs}`);
  }

  let raw: string;
  if (args.bodyHtml) {
    const boundary = `bnb=_${Math.floor(Math.random() * 1e9).toString(36)}`;
    raw = [
      ...commonHeaders,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      args.bodyText,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      args.bodyHtml,
      '',
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    raw = [
      ...commonHeaders,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      args.bodyText,
    ].join('\r\n');
  }

  const base64Url = Buffer.from(raw, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const body: Record<string, string> = { raw: base64Url };
  if (args.threadId) body.threadId = args.threadId;

  const res = await fetch(`${GMAIL_API_BASE}/messages/send`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gmail send failed: ${res.status} ${err.slice(0, 200)}`);
  }
  const data = await res.json() as { id: string; threadId: string };
  return { messageId: data.id, threadId: data.threadId };
}

export type ThreadMessage = {
  id:           string;
  threadId:     string;
  labelIds:     string[];
  internalDate: string;   // ms since epoch
  from:         string;
  snippet:      string;
  /** RFC 822 Message-Id header, if present. Used to stamp
   *  In-Reply-To / References on subsequent CRM-side replies. */
  rfcMessageId: string | null;
  subject:      string;
  /** Prior References header on this message (space-separated
   *  message-ids), if any. Passed through when composing a reply. */
  references:   string | null;
  inReplyTo:    string | null;
};

// Header set requested on every thread/message metadata fetch.
// Adding one costs nothing per call; keeping this in one place means
// every ingest path automatically captures the RFC threading info.
const METADATA_HEADERS =
  'metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Subject' +
  '&metadataHeaders=Message-Id&metadataHeaders=References&metadataHeaders=In-Reply-To';

type ApiMsg = {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
};

function pickHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string | null {
  const lc = name.toLowerCase();
  const h = headers?.find(x => x.name.toLowerCase() === lc);
  return h?.value ?? null;
}

function projectApiMsg(m: ApiMsg): ThreadMessage {
  const headers = m.payload?.headers;
  return {
    id:           m.id,
    threadId:     m.threadId,
    labelIds:     m.labelIds ?? [],
    internalDate: m.internalDate ?? '0',
    from:         pickHeader(headers, 'from')       ?? '',
    snippet:      m.snippet ?? '',
    rfcMessageId: pickHeader(headers, 'message-id'),
    subject:      pickHeader(headers, 'subject')    ?? '',
    references:   pickHeader(headers, 'references'),
    inReplyTo:    pickHeader(headers, 'in-reply-to'),
  };
}

export async function fetchThread(accessToken: string, threadId: string): Promise<ThreadMessage[]> {
  const res = await fetch(
    `${GMAIL_API_BASE}/threads/${encodeURIComponent(threadId)}?format=metadata&${METADATA_HEADERS}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    if (res.status === 404) return [];
    const err = await res.text().catch(() => '');
    throw new Error(`Gmail thread fetch failed: ${res.status} ${err.slice(0, 200)}`);
  }
  const parsed = await res.json() as { messages?: ApiMsg[] };
  return (parsed.messages ?? []).map(projectApiMsg);
}

// ── Push notifications: watch / stop / history ───────────────────────

/**
 * Start (or renew) a Gmail push watch on INBOX. Google requires you
 * publish an existing Pub/Sub topic; this client sends topicName and
 * assumes the topic exists + has permission granted to
 * gmail-api-push@system.gserviceaccount.com.
 *
 * Returns { historyId, expiration } — expiration is an ms-since-epoch
 * string per the Gmail API (converted to Date at the callsite).
 */
export async function startGmailWatch(
  accessToken: string,
  topicName: string,
): Promise<{ historyId: string; expiration: string }> {
  const res = await fetch(`${GMAIL_API_BASE}/watch`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterAction: 'include' }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gmail watch failed: ${res.status} ${err.slice(0, 200)}`);
  }
  return await res.json() as { historyId: string; expiration: string };
}

export async function stopGmailWatch(accessToken: string): Promise<void> {
  const res = await fetch(`${GMAIL_API_BASE}/stop`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gmail stop failed: ${res.status} ${err.slice(0, 200)}`);
  }
}

export type HistoryMessageAdded = {
  message: { id: string; threadId: string; labelIds?: string[] };
};

export type HistoryPage = {
  history?: Array<{ messagesAdded?: HistoryMessageAdded[] }>;
  historyId?: string;
  nextPageToken?: string;
};

/**
 * List history from a given startHistoryId. Only INBOX messagesAdded
 * events are requested — matches the labelIds filter on watch().
 * Returns { messages, newHistoryId }. On 404 (historyId too old) the
 * caller must reset by falling back to full-poll.
 */
export async function listHistoryFrom(
  accessToken: string,
  startHistoryId: string,
): Promise<
  | { kind: 'ok';         messages: HistoryMessageAdded[]; newHistoryId: string | null }
  | { kind: 'expired' }
> {
  const messages: HistoryMessageAdded[] = [];
  let pageToken: string | undefined;
  let latestHistoryId: string | null = null;

  for (let i = 0; i < 20; i++) {   // hard cap on pagination
    const url = new URL(`${GMAIL_API_BASE}/history`);
    url.searchParams.set('startHistoryId', startHistoryId);
    url.searchParams.set('historyTypes',   'messageAdded');
    url.searchParams.set('labelId',        'INBOX');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (res.status === 404) return { kind: 'expired' };
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Gmail history failed: ${res.status} ${err.slice(0, 200)}`);
    }
    const page = await res.json() as HistoryPage;
    if (page.historyId) latestHistoryId = page.historyId;
    for (const h of (page.history ?? [])) {
      for (const m of (h.messagesAdded ?? [])) messages.push(m);
    }
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  return { kind: 'ok', messages, newHistoryId: latestHistoryId };
}

/**
 * Fetch a single Gmail message (metadata only — From, Subject, Date,
 * Message-Id, References, In-Reply-To). Used by:
 *   • the push handler to convert a historyId event into a match candidate
 *   • the compose action to look up our own Message-Id after send
 *   • the reply-mode context builder to load subject + rfc id
 */
export async function fetchMessageMetadata(
  accessToken: string,
  messageId: string,
): Promise<ThreadMessage | null> {
  const res = await fetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=metadata&${METADATA_HEADERS}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gmail message fetch failed: ${res.status} ${err.slice(0, 200)}`);
  }
  const m = await res.json() as ApiMsg;
  return projectApiMsg(m);
}
