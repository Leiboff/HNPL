// ─── Client-safe projection for the settings page ────────────────────
//
// The /crm/settings server component fetches crm_email_accounts rows
// (via the service-role client — the table is deny-all to session
// clients) and passes SOMETHING to the client. What "something" is is
// the token-isolation boundary: only display-safe fields cross that
// boundary. This module is the projection helper both the page and
// the tests use so the contract is asserted behaviourally, not by grep.
//
// Anything not in ClientSafeGmailAccount MUST NOT leave the server.

export type GmailAccountStatus = 'connected' | 'reauth_required' | 'revoked';

export type ClientSafeGmailAccount = {
  id:              string;
  gmailAddress:    string;
  status:          GmailAccountStatus;
  connectedAt:     string;
  lastUsedAt:      string | null;
  lastPolledAt:    string | null;
  watchExpiresAt:  string | null;
};

/** Row shape as it comes back from Supabase for crm_email_accounts.
 *  The token-carrying columns are typed `never` so a naive mapper that
 *  spreads (`{...row}`) fails at compile-time. */
export type RawGmailAccountRow = {
  id?:                  string | null;
  gmail_address?:       string | null;
  status?:              string | null;
  connected_at?:        string | null;
  last_used_at?:        string | null;
  last_polled_at?:      string | null;
  watch_expires_at?:    string | null;

  // Fields intentionally excluded from the projection.
  refresh_token_enc?:   never;
  access_token_cache?:  never;
  access_token_expiry?: never;
  user_id?:             never;
  last_history_id?:     never;
};

const STATUS_SET: ReadonlySet<GmailAccountStatus> =
  new Set(['connected', 'reauth_required', 'revoked'] as const);

export function toClientSafeGmailAccount(
  raw: RawGmailAccountRow | null | undefined,
): ClientSafeGmailAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.gmail_address !== 'string' || !raw.gmail_address) return null;
  const status = typeof raw.status === 'string' ? raw.status as GmailAccountStatus : null;
  if (!status || !STATUS_SET.has(status)) return null;
  return {
    id:             raw.id,
    gmailAddress:   raw.gmail_address,
    status,
    connectedAt:    typeof raw.connected_at === 'string' ? raw.connected_at : new Date(0).toISOString(),
    lastUsedAt:     typeof raw.last_used_at === 'string' ? raw.last_used_at : null,
    lastPolledAt:   typeof raw.last_polled_at === 'string' ? raw.last_polled_at : null,
    watchExpiresAt: typeof raw.watch_expires_at === 'string' ? raw.watch_expires_at : null,
  };
}

export function toClientSafeGmailAccounts(
  rows: RawGmailAccountRow[] | null | undefined,
): ClientSafeGmailAccount[] {
  if (!Array.isArray(rows)) return [];
  const out: ClientSafeGmailAccount[] = [];
  for (const r of rows) {
    const p = toClientSafeGmailAccount(r);
    if (p) out.push(p);
  }
  return out;
}
