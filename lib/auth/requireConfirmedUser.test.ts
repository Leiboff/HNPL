import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const getUser   = vi.fn();
const redirectSpy = vi.fn((url: string) => {
  // Next's `redirect()` throws a special error to abort rendering. We
  // mimic that so callers stop at the redirect boundary the same way.
  const e = new Error(`NEXT_REDIRECT:${url}`);
  (e as Error & { __redirect: string }).__redirect = url;
  throw e;
});

vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectSpy(url),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser } })),
}));

import { requireConfirmedUser } from './requireConfirmedUser';

beforeEach(() => {
  getUser.mockReset();
  redirectSpy.mockClear();
});

function expectRedirect(thrown: unknown, expected: string | RegExp) {
  expect(thrown).toBeInstanceOf(Error);
  const url = (thrown as Error & { __redirect?: string }).__redirect ?? '';
  if (typeof expected === 'string') expect(url).toBe(expected);
  else expect(url).toMatch(expected);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('requireConfirmedUser', () => {
  it('redirects to /login when getUser returns no user', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    let caught: unknown;
    try { await requireConfirmedUser(); } catch (e) { caught = e; }
    expectRedirect(caught, '/login');
  });

  it('honours unauthenticatedRedirect override', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    let caught: unknown;
    try {
      await requireConfirmedUser({ unauthenticatedRedirect: '/login?return=/admin' });
    } catch (e) { caught = e; }
    expectRedirect(caught, '/login?return=/admin');
  });

  it('redirects to /verify-email when user exists but email_confirmed_at is null', async () => {
    getUser.mockResolvedValueOnce({ data: { user: {
      id: 'u1', email: 'jane@example.com', email_confirmed_at: null,
    }}});
    let caught: unknown;
    try { await requireConfirmedUser({ next: '/patient' }); } catch (e) { caught = e; }
    expectRedirect(caught, /^\/verify-email\?/);
    const url = (caught as Error & { __redirect: string }).__redirect;
    expect(url).toContain('email=jane%40example.com');
    expect(url).toContain('next=%2Fpatient');
  });

  it('uses next=/ as the default when not provided', async () => {
    getUser.mockResolvedValueOnce({ data: { user: {
      id: 'u1', email: 'jane@example.com', email_confirmed_at: null,
    }}});
    let caught: unknown;
    try { await requireConfirmedUser(); } catch (e) { caught = e; }
    const url = (caught as Error & { __redirect: string }).__redirect;
    expect(url).toContain('next=%2F');
  });

  it('omits email param when the user has no email (edge case)', async () => {
    getUser.mockResolvedValueOnce({ data: { user: {
      id: 'u1', email: null, email_confirmed_at: null,
    }}});
    let caught: unknown;
    try { await requireConfirmedUser({ next: '/patient' }); } catch (e) { caught = e; }
    const url = (caught as Error & { __redirect: string }).__redirect;
    expect(url).not.toContain('email=');
    expect(url).toContain('next=%2Fpatient');
  });

  it('returns { user, supabase } when the user is confirmed', async () => {
    getUser.mockResolvedValueOnce({ data: { user: {
      id: 'u1', email: 'jane@example.com', email_confirmed_at: '2026-01-01T00:00:00Z',
    }}});
    const result = await requireConfirmedUser();
    expect(result.user.id).toBe('u1');
    expect(result.user.email).toBe('jane@example.com');
    expect(result.supabase).toBeDefined();
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});
