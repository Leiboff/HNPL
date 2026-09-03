import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── sendPushToUser — preference + retire-on-410 contract ────────────────
//
// The patient's "off" preference is encoded by deleted_at being non-
// null. These tests prove:
//
//   1. Subs with deleted_at IS NOT NULL are never sent to (the toggle
//      is authoritative — turning it off truly stops the sender).
//   2. Active subs ARE sent to.
//   3. A 410 Gone from the push service soft-deletes that row (the
//      browser uninstalled / cleared data; we save the next roundtrip).
//   4. Transient failures (5xx) leave the row alive (we'll retry).
//   5. VAPID missing = silent no-op (we don't crash the webhook).

// ── Mock web-push BEFORE importing the module under test ────────────
const sendNotificationMock = vi.fn();
vi.mock('web-push', () => ({
  default: {
    setVapidDetails:  vi.fn(),
    sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
  },
}));

// ── Mock the Supabase client. The sender filters by `deleted_at IS NULL`
//    via `.is('deleted_at', null)` — our stub honours that.
const updateMock = vi.fn();

type StubSub = {
  id:         string;
  user_id:    string;
  endpoint:   string;
  p256dh:     string;
  auth:       string;
  deleted_at: string | null;
};

let stubSubs: StubSub[] = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      if (table !== 'push_subscriptions') {
        throw new Error(`unexpected table: ${table}`);
      }
      return {
        select(_cols: string) {  // eslint-disable-line @typescript-eslint/no-unused-vars
          const filters: Array<(s: StubSub) => boolean> = [];
          const chain = {
            eq(col: 'user_id' | 'id', val: string) {
              filters.push((s) => (s as unknown as Record<string, unknown>)[col] === val);
              return chain;
            },
            is(col: 'deleted_at', val: null) {
              filters.push((s) => s[col] === val);
              return Promise.resolve({
                data: stubSubs.filter((s) => filters.every((f) => f(s))),
                error: null,
              });
            },
          };
          return chain;
        },
        update(patch: Partial<StubSub>) {
          const filters: Array<(s: StubSub) => boolean> = [];
          const chain = {
            eq(col: 'id', val: string) {
              filters.push((s) => s.id === val);
              return chain;
            },
            then(resolve: (v: { error: null }) => void) {
              for (const s of stubSubs) {
                if (filters.every((f) => f(s))) Object.assign(s, patch);
              }
              updateMock({ patch, filters: filters.length });
              resolve({ error: null });
              return undefined;
            },
          };
          return chain;
        },
      };
    },
  }),
}));

// VAPID env BEFORE module import
process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'pub';
process.env.VAPID_PRIVATE_KEY             = 'priv';
process.env.VAPID_SUBJECT                 = 'mailto:test@example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL      = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY     = 'svc';

const { sendPushToUser } = await import('./sendPush');

beforeEach(() => {
  sendNotificationMock.mockReset();
  updateMock.mockReset();
  stubSubs = [];
});

describe('sendPushToUser — preference respect (master switch governs ALL types)', () => {
  it('does NOT send when ALL subs are soft-deleted (toggle off)', async () => {
    stubSubs = [
      { id: 's1', user_id: 'user-1', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'p1', auth: 'a1', deleted_at: '2026-06-18T00:00:00Z' },
      { id: 's2', user_id: 'user-1', endpoint: 'https://fcm.googleapis.com/fcm/send/y', p256dh: 'p2', auth: 'a2', deleted_at: '2026-06-18T00:00:00Z' },
    ];

    const result = await sendPushToUser('user-1', { type: 'payment', title: 't', body: 'b' });

    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(result.total).toBe(0);  // The query filtered them out — they don't even count.
  });

  it('sends to active subs and ignores soft-deleted ones at the same time', async () => {
    stubSubs = [
      { id: 'live',  user_id: 'user-1', endpoint: 'https://fcm.googleapis.com/fcm/send/a', p256dh: 'p1', auth: 'a1', deleted_at: null },
      { id: 'dead',  user_id: 'user-1', endpoint: 'https://fcm.googleapis.com/fcm/send/b', p256dh: 'p2', auth: 'a2', deleted_at: '2026-06-18T00:00:00Z' },
    ];
    sendNotificationMock.mockResolvedValue({});

    const result = await sendPushToUser('user-1', { type: 'plan', title: 't', body: 'b' });

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(1);
    expect(result.sent).toBe(1);
  });

  it('the master switch off blocks EVERY notification type — payment, plan, account, general', async () => {
    // The single preference governs all categories. A patient who
    // turned off notifications must receive nothing of any kind, not
    // just no payment messages — that's the whole point of the
    // generalisation.
    stubSubs = [
      { id: 'off', user_id: 'user-1', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'p', auth: 'a', deleted_at: '2026-06-18T00:00:00Z' },
    ];

    const r1 = await sendPushToUser('user-1', { type: 'payment', title: 'p', body: 'p' });
    const r2 = await sendPushToUser('user-1', { type: 'plan',    title: 'p', body: 'p' });
    const r3 = await sendPushToUser('user-1', { type: 'account', title: 'p', body: 'p' });
    const r4 = await sendPushToUser('user-1', { type: 'general', title: 'p', body: 'p' });

    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(r1.sent + r2.sent + r3.sent + r4.sent).toBe(0);
  });

  it('payload bytes sent to the push service include the type field', async () => {
    // The SW can read `type` from the JSON payload — important for
    // future per-category styling without a protocol change.
    stubSubs = [
      { id: 'live', user_id: 'user-1', endpoint: 'https://fcm.googleapis.com/fcm/send/a', p256dh: 'p', auth: 'a', deleted_at: null },
    ];
    sendNotificationMock.mockResolvedValue({});

    await sendPushToUser('user-1', { type: 'account', title: 'Email confirmed', body: 'You\'re all set.' });

    const [, body] = sendNotificationMock.mock.calls[0] as [unknown, string];
    const decoded = JSON.parse(body);
    expect(decoded.type).toBe('account');
    expect(decoded.title).toBe('Email confirmed');
  });
});

describe('sendPushToUser — retire on 410 Gone', () => {
  it('soft-deletes a sub whose endpoint returns 410', async () => {
    stubSubs = [
      { id: 'gone', user_id: 'user-1', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'p', auth: 'a', deleted_at: null },
    ];
    sendNotificationMock.mockRejectedValueOnce({ statusCode: 410, message: 'Gone' });

    const result = await sendPushToUser('user-1', { type: 'payment', title: 't', body: 'b' });

    expect(result.retired).toBe(1);
    expect(result.sent).toBe(0);
    // The stub row was patched in place — proves the soft-delete fired.
    expect(stubSubs[0].deleted_at).not.toBeNull();
  });

  it('does NOT soft-delete on a transient 5xx', async () => {
    stubSubs = [
      { id: 'flaky', user_id: 'user-1', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'p', auth: 'a', deleted_at: null },
    ];
    sendNotificationMock.mockRejectedValueOnce({ statusCode: 502, message: 'Bad Gateway' });

    const result = await sendPushToUser('user-1', { type: 'payment', title: 't', body: 'b' });

    expect(result.failed).toBe(1);
    expect(stubSubs[0].deleted_at).toBeNull();
  });

  it('retires a legacy untrusted endpoint without making an outbound request', async () => {
    stubSubs = [
      { id: 'legacy-ssrf', user_id: 'user-1', endpoint: 'https://10.0.0.7/internal', p256dh: 'p', auth: 'a', deleted_at: null },
    ];

    const result = await sendPushToUser('user-1', { type: 'account', title: 't', body: 'b' });

    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(result.retired).toBe(1);
    expect(stubSubs[0].deleted_at).not.toBeNull();
  });
});
