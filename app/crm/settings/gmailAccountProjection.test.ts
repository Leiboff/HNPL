import { describe, it, expect } from 'vitest';
import { toClientSafeGmailAccount } from './gmailAccountProjection';

// ─── Behavioural — the server → client boundary drops token material.
//
// The projection function is the single point where a raw
// crm_email_accounts row becomes something the client renders. If
// this drops the wrong field, refresh tokens or ciphertext land in
// the RSC payload. Assert the shape by inspecting the returned object.

describe('toClientSafeGmailAccount — token isolation at the RSC boundary', () => {
  const raw = {
    id:                  'row-1',
    user_id:             'user-1',
    gmail_address:       'alice@example.com',
    status:              'connected' as const,
    connected_at:        '2026-07-13T10:00:00.000Z',
    refresh_token_enc:   'v1:iv:tag:ciphertext-DO-NOT-LEAK',
    access_token_cache:  'ya29.some.access.token-DO-NOT-LEAK',
    access_token_expiry: '2026-07-13T11:00:00.000Z',
    last_polled_at:      '2026-07-13T10:30:00.000Z',
  };

  it('returns exactly { gmailAddress, status, connectedAt }', () => {
    const out = toClientSafeGmailAccount(raw)!;
    expect(Object.keys(out).sort()).toEqual(['connectedAt', 'gmailAddress', 'status']);
    expect(out.gmailAddress).toBe('alice@example.com');
    expect(out.status).toBe('connected');
    expect(out.connectedAt).toBe('2026-07-13T10:00:00.000Z');
  });

  it('does NOT surface any token or ciphertext field', () => {
    const out = toClientSafeGmailAccount(raw);
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('refresh_token');
    expect(serialised).not.toContain('access_token');
    expect(serialised).not.toContain('ciphertext-DO-NOT-LEAK');
    expect(serialised).not.toContain('ya29.');
    expect(serialised).not.toContain('access_token_expiry');
    expect(serialised).not.toContain('last_polled_at');
    expect(serialised).not.toContain('user_id');
    // Row id also stays server-side — the client works off gmail_address alone.
    expect(serialised).not.toContain('row-1');
  });

  it('returns null on missing raw row (nothing surfaced at all)', () => {
    expect(toClientSafeGmailAccount(null)).toBeNull();
    expect(toClientSafeGmailAccount(undefined)).toBeNull();
    expect(toClientSafeGmailAccount({})).toBeNull();
  });

  it('returns null on an unknown status value (defensive — no rogue enum leak)', () => {
    const out = toClientSafeGmailAccount({ ...raw, status: 'bogus' });
    expect(out).toBeNull();
  });
});

describe('token isolation regression — /crm/settings page wires through the projection', () => {
  it('page.tsx uses toClientSafeGmailAccount and never destructures token columns', async () => {
    const src = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(process.cwd(), 'app/crm/settings/page.tsx'),
      'utf8',
    );
    expect(src).toMatch(/toClientSafeGmailAccount/);
    // Guard against a regression that re-introduces manual field copy
    // (the previous shape); if a future refactor inlines the columns
    // again, they must not include token material.
    expect(src).not.toMatch(/refresh_token/);
    expect(src).not.toMatch(/access_token/);
  });
});
