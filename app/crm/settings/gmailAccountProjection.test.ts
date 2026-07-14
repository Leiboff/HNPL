import { describe, it, expect } from 'vitest';
import { toClientSafeGmailAccount, toClientSafeGmailAccounts } from './gmailAccountProjection';

// ─── Behavioural — the server → client boundary drops token material.
//
// The projection function is the single point where raw
// crm_email_accounts rows become something the client renders. If
// this drops the wrong field, refresh tokens or ciphertext land in
// the RSC payload.

describe('toClientSafeGmailAccount — token isolation at the RSC boundary', () => {
  const raw = {
    id:                  'row-1',
    user_id:             'user-1',
    gmail_address:       'alice@example.com',
    status:              'connected' as const,
    connected_at:        '2026-07-13T10:00:00.000Z',
    last_used_at:        '2026-07-13T10:45:00.000Z',
    last_polled_at:      '2026-07-13T10:30:00.000Z',
    watch_expires_at:    '2026-07-20T10:00:00.000Z',
    refresh_token_enc:   'v1:iv:tag:ciphertext-DO-NOT-LEAK',
    access_token_cache:  'ya29.some.access.token-DO-NOT-LEAK',
    access_token_expiry: '2026-07-13T11:00:00.000Z',
    last_history_id:     '12345',
  } as unknown as Parameters<typeof toClientSafeGmailAccount>[0];

  it('returns only display-safe fields', () => {
    const out = toClientSafeGmailAccount(raw)!;
    expect(Object.keys(out).sort()).toEqual([
      'connectedAt', 'gmailAddress', 'id', 'lastPolledAt', 'lastUsedAt', 'status', 'watchExpiresAt',
    ]);
    expect(out.gmailAddress).toBe('alice@example.com');
    expect(out.status).toBe('connected');
    expect(out.connectedAt).toBe('2026-07-13T10:00:00.000Z');
    expect(out.lastUsedAt).toBe('2026-07-13T10:45:00.000Z');
    expect(out.watchExpiresAt).toBe('2026-07-20T10:00:00.000Z');
  });

  it('does NOT surface any token / ciphertext / user_id / history_id field', () => {
    const out = toClientSafeGmailAccount(raw);
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('refresh_token');
    expect(serialised).not.toContain('access_token');
    expect(serialised).not.toContain('ciphertext-DO-NOT-LEAK');
    expect(serialised).not.toContain('ya29.');
    expect(serialised).not.toContain('access_token_expiry');
    expect(serialised).not.toContain('user_id');
    expect(serialised).not.toContain('last_history_id');
    // history-id VALUE also stays server-side.
    expect(serialised).not.toContain('12345');
  });

  it('returns null on missing raw row (nothing surfaced at all)', () => {
    expect(toClientSafeGmailAccount(null)).toBeNull();
    expect(toClientSafeGmailAccount(undefined)).toBeNull();
    expect(toClientSafeGmailAccount({} as never)).toBeNull();
  });

  it('returns null on an unknown status value (defensive — no rogue enum leak)', () => {
    const out = toClientSafeGmailAccount({ ...raw, status: 'bogus' } as never);
    expect(out).toBeNull();
  });
});

describe('toClientSafeGmailAccounts (list form)', () => {
  it('drops null projections and keeps the surviving order', () => {
    const rows = [
      { id: 'a', gmail_address: 'a@x.com', status: 'connected', connected_at: '2026-07-13T10:00:00.000Z' },
      { id: 'b', gmail_address: 'b@x.com', status: 'invalid',   connected_at: '2026-07-13T10:00:00.000Z' },
      { id: 'c', gmail_address: 'c@x.com', status: 'reauth_required', connected_at: '2026-07-13T10:00:00.000Z' },
    ] as unknown as Parameters<typeof toClientSafeGmailAccounts>[0];
    const out = toClientSafeGmailAccounts(rows);
    expect(out.map(o => o.gmailAddress)).toEqual(['a@x.com', 'c@x.com']);
  });
});

describe('token isolation regression — /crm/settings page wires through the projection', () => {
  it('page.tsx uses toClientSafeGmailAccounts and never destructures token columns', async () => {
    const src = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(process.cwd(), 'app/crm/settings/page.tsx'),
      'utf8',
    );
    expect(src).toMatch(/toClientSafeGmailAccounts/);
    expect(src).not.toMatch(/refresh_token/);
    expect(src).not.toMatch(/access_token/);
  });
});
