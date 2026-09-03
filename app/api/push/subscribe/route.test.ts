import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const createServiceClientMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
    },
  }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => createServiceClientMock(...args),
}));

const { POST } = await import('./route');

function subscriptionRequest(endpoint: string) {
  return new NextRequest('https://app.example.test/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint,
      keys: { p256dh: 'public-key', auth: 'auth-secret' },
    }),
  });
}

beforeEach(() => {
  createServiceClientMock.mockReset();
});

describe('POST /api/push/subscribe endpoint boundary', () => {
  it.each([
    'https://127.0.0.1/internal',
    'https://10.0.0.7/internal',
    'https://169.254.169.254/latest/meta-data',
    'https://evil.example/relay',
    'https://fcm.googleapis.com.evil.example/fcm/send/x',
  ])('rejects an untrusted endpoint before creating a privileged client: %s', async (endpoint) => {
    const response = await POST(subscriptionRequest(endpoint));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_subscription' });
    expect(createServiceClientMock).not.toHaveBeenCalled();
  });
});
