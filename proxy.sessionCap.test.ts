import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { SESSION_CAP_REDIRECT_REASON } from '@/lib/auth/sessionCap';

const { signOut, updateSession } = vi.hoisted(() => ({
  signOut: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('@/lib/supabase/middleware', () => ({ updateSession }));

import { proxy } from './proxy';

const expiredUser = {
  last_sign_in_at: '2000-01-01T00:00:00.000Z',
};

function mockExpiredSession() {
  updateSession.mockResolvedValue({
    response: NextResponse.next(),
    user: expiredUser,
    supabase: { auth: { signOut } },
  });
}

describe('proxy absolute session cap responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signOut.mockResolvedValue({ error: null });
    mockExpiredSession();
  });

  it.each(['GET', 'POST'])('returns a JSON 401 to %s API requests', async (method) => {
    const request = new NextRequest('https://example.test/api/payment-methods/recent', { method });
    request.cookies.set('sb-abcdefghij-auth-token', 'session');
    request.cookies.set('preference', 'compact');

    const response = await proxy(request);

    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      error: 'unauthenticated',
      reason: SESSION_CAP_REDIRECT_REASON,
    });
    expect(signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(response.headers.get('set-cookie')).toContain('sb-abcdefghij-auth-token=;');
  });

  it('keeps the login redirect for document requests', async () => {
    const response = await proxy(new NextRequest('https://example.test/patient?tab=orders'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      `https://example.test/login?reason=${SESSION_CAP_REDIRECT_REASON}`,
    );
  });
});
