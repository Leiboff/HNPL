// ─── Gmail API — thin, dependency-free client ─────────────────────────
//
// We call the Gmail REST API directly via fetch — no @googleapis/gmail
// dep, no oauth2 SDK. Everything below is service-side; refresh tokens
// live in crm_email_accounts.refresh_token_enc (AES-256-GCM) and are
// decrypted only inside the getAccessToken() helper here.

import { encryptToken, decryptToken } from '@/lib/crypto/tokenEncryption';
import { createClient as createServiceClient } from '@supabase/supabase-js';

// ── Configuration ────────────────────────────────────────────────────

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

export const OAUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

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
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
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
}): Promise<{ error?: string }> {
  const s = svc();
  const encRt = encryptToken(input.refreshToken);
  const { error } = await s.from('crm_email_accounts').upsert({
    user_id:             input.userId,
    gmail_address:       input.gmailAddress,
    refresh_token_enc:   encRt,
    access_token_cache:  input.accessToken,
    access_token_expiry: input.expiresAt.toISOString(),
    connected_at:        new Date().toISOString(),
    status:              'connected',
  }, { onConflict: 'user_id' });
  if (error) return { error: error.message };
  return {};
}

export async function getAccessToken(userId: string): Promise<{ accessToken: string; account: GmailAccount } | { error: string }> {
  const s = svc();
  const { data, error } = await s
    .from('crm_email_accounts')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: 'gmail_not_connected' };
  const account = data as unknown as GmailAccount;
  if (account.status !== 'connected') return { error: 'gmail_reauth_required' };

  // Cached access token still valid?
  const cachedExpiry = account.access_token_expiry ? new Date(account.access_token_expiry) : null;
  if (account.access_token_cache && cachedExpiry && cachedExpiry.getTime() - 30_000 > Date.now()) {
    return { accessToken: account.access_token_cache, account };
  }

  // Refresh.
  try {
    const refreshToken = decryptToken(account.refresh_token_enc);
    const { accessToken, expiresAt } = await refreshAccessToken(refreshToken);
    await s.from('crm_email_accounts')
      .update({ access_token_cache: accessToken, access_token_expiry: expiresAt.toISOString() })
      .eq('user_id', userId);
    return { accessToken, account: { ...account, access_token_cache: accessToken, access_token_expiry: expiresAt.toISOString() } };
  } catch (err) {
    // Google revoked or key rotated — flag for reconnect.
    await s.from('crm_email_accounts').update({ status: 'reauth_required' }).eq('user_id', userId);
    return { error: 'gmail_reauth_required' };
  }
}

export async function revokeGmailAccount(userId: string): Promise<{ error?: string }> {
  const s = svc();
  const { data } = await s.from('crm_email_accounts').select('refresh_token_enc').eq('user_id', userId).maybeSingle();
  if (data?.refresh_token_enc) {
    try {
      const refreshToken = decryptToken(data.refresh_token_enc as string);
      await fetch(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ token: refreshToken }),
      }).catch(() => { /* revocation is best-effort */ });
    } catch { /* corrupt token — proceed to delete */ }
  }
  const { error } = await s.from('crm_email_accounts').delete().eq('user_id', userId);
  if (error) return { error: error.message };
  return {};
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
};

/**
 * Build an RFC-822 message and send via Gmail's users.messages.send.
 * The body is plain-text; we don't offer HTML compose in Phase 2.
 * Returns { messageId, threadId } from the Gmail response.
 */
export async function sendGmail(args: SendArgs): Promise<{ messageId: string; threadId: string }> {
  const headers = [
    `From: "${args.fromName}" <${args.from}>`,
    `To: ${args.to}`,
    `Subject: ${args.subject.replace(/[\r\n]/g, ' ')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
  ].join('\r\n');
  const raw = `${headers}\r\n\r\n${args.bodyText}`;
  const base64Url = Buffer.from(raw, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ raw: base64Url }),
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
};

export async function fetchThread(accessToken: string, threadId: string): Promise<ThreadMessage[]> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Date`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    if (res.status === 404) return [];
    const err = await res.text().catch(() => '');
    throw new Error(`Gmail thread fetch failed: ${res.status} ${err.slice(0, 200)}`);
  }
  type ApiMsg = {
    id: string;
    threadId: string;
    labelIds?: string[];
    internalDate?: string;
    snippet?: string;
    payload?: { headers?: Array<{ name: string; value: string }> };
  };
  const parsed = await res.json() as { messages?: ApiMsg[] };
  return (parsed.messages ?? []).map((m) => {
    const fromHdr = m.payload?.headers?.find(h => h.name.toLowerCase() === 'from');
    return {
      id:           m.id,
      threadId:     m.threadId,
      labelIds:     m.labelIds ?? [],
      internalDate: m.internalDate ?? '0',
      from:         fromHdr?.value ?? '',
      snippet:      m.snippet ?? '',
    };
  });
}
