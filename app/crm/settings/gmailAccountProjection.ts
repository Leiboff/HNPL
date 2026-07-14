// ─── Client-safe projection for the settings page ────────────────────
//
// The /crm/settings server component fetches a crm_email_accounts row
// (via the service-role client — the table is deny-all to session
// clients) and passes SOMETHING to the client GmailConnectionCard
// component. What "something" is is the token-isolation boundary:
// only the three display-safe fields cross that boundary. This module
// is the projection helper both the page and the tests use so the
// contract is asserted behaviourally, not by grep.
//
// Anything not in ClientSafeGmailAccount MUST NOT leave the server.

export type ClientSafeGmailAccount = {
  gmailAddress: string;
  status:       'connected' | 'reauth_required' | 'revoked';
  connectedAt:  string;
};

/** Row shape as it comes back from Supabase for crm_email_accounts. */
export type RawGmailAccountRow = {
  gmail_address?:       string | null;
  status?:              string | null;
  connected_at?:        string | null;
  // The rest of the columns MUST NOT be surfaced. Listing them here
  // explicitly is intentional — a future column addition needs a
  // conscious decision to expose or hide it.
  refresh_token_enc?:   string | null;
  access_token_cache?:  string | null;
  access_token_expiry?: string | null;
  last_polled_at?:      string | null;
  user_id?:             string | null;
  id?:                  string | null;
};

/**
 * Project a raw crm_email_accounts row to the shape the client can
 * see. Explicitly picks only three fields. Any token / cache /
 * timestamp column that would let a caller reconstruct or misuse the
 * connection is dropped.
 */
export function toClientSafeGmailAccount(
  raw: RawGmailAccountRow | null | undefined,
): ClientSafeGmailAccount | null {
  if (!raw || !raw.gmail_address || !raw.status || !raw.connected_at) return null;
  const status = raw.status;
  if (status !== 'connected' && status !== 'reauth_required' && status !== 'revoked') return null;
  return {
    gmailAddress: raw.gmail_address,
    status,
    connectedAt:  raw.connected_at,
  };
}
