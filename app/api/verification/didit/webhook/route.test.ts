// @vitest-environment node
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';
import { NextRequest } from 'next/server';
import { signDiditWebhookForTesting } from '@/lib/didit/webhook';
import { VALID_SA_IDS, INVALID_SA_IDS } from '@/lib/testing/saIdFixtures';

// ─── Didit webhook route — surface-level integration tests ──────────────
//
// The DB layer is mocked; this suite is about the route's signature
// verification, idempotency, status mapping, and the re-validation +
// duplicate-SA-ID gate on the Approved path — not Supabase itself.

const SECRET = 'test-didit-webhook-secret';
const USER_ID = 'user-1';

type Row = Record<string, unknown>;

const dbState: {
  profiles:            Row[];
  webhookEventIds:     Set<string>;
  profileUpdates:      Row[];
} = { profiles: [], webhookEventIds: new Set(), profileUpdates: [] };

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from(table: string) {
      if (table === 'didit_webhook_events') {
        return {
          insert: async (row: { event_id: string }) => {
            if (dbState.webhookEventIds.has(row.event_id)) {
              return { error: { code: '23505', message: 'duplicate key' } };
            }
            dbState.webhookEventIds.add(row.event_id);
            return { error: null };
          },
        };
      }
      if (table === 'profiles') {
        return {
          update: (row: Row) => {
            const builder = {
              eq: (col: string, val: unknown) => {
                const idx = dbState.profiles.findIndex((p) => p[col] === val);
                if (idx >= 0) dbState.profiles[idx] = { ...dbState.profiles[idx], ...row };
                dbState.profileUpdates.push({ ...row, __eq: { [col]: val } });
                return Promise.resolve({ data: null, error: null });
              },
            };
            return builder;
          },
          select: () => {
            const filters: Array<(row: Row) => boolean> = [];
            const builder = {
              eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
              order() { return builder; },
              limit: async (n: number) => ({
                data: dbState.profiles.filter((r) => filters.every((f) => f(r))).slice(0, n),
                error: null,
              }),
            };
            return builder;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  })),
}));

// Import AFTER mocks are wired.
import { POST } from './route';

function buildRequest(body: unknown, opts?: { signature?: string; timestamp?: string; skipSign?: boolean }): NextRequest {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!opts?.skipSign) {
    const { signature, timestamp } = signDiditWebhookForTesting({
      body, secret: SECRET, timestamp: opts?.timestamp,
    });
    headers['x-signature-v2'] = opts?.signature ?? signature;
    headers['x-timestamp']    = timestamp;
  }
  return new NextRequest('https://app.test/api/verification/didit/webhook', {
    method: 'POST',
    headers,
    body: raw,
  });
}

function approvedEvent(overrides?: Partial<Row>): Row {
  return {
    event_id:         'evt-1',
    webhook_type:     'status.updated',
    timestamp:        Math.floor(Date.now() / 1000),
    created_at:        Math.floor(Date.now() / 1000),
    application_id:   'app-1',
    environment:       'sandbox',
    session_id:       'sess-1',
    status:           'Approved',
    workflow_id:      'wf-1',
    workflow_version: 1,
    vendor_data:      USER_ID,
    metadata:         null,
    decision: {
      id_verifications: [{ personal_number: VALID_SA_IDS[0] }],
      liveness_checks:  [{ status: 'Approved' }],
      face_matches:     [{ status: 'Approved' }],
    },
    ...overrides,
  };
}

beforeAll(() => {
  process.env.SA_ID_ENCRYPTION_KEY  = randomBytes(32).toString('base64');
  process.env.SA_ID_LOOKUP_HMAC_KEY = randomBytes(32).toString('base64');
});

beforeEach(() => {
  process.env.DIDIT_WEBHOOK_SECRET = SECRET;
  dbState.profiles       = [{ id: USER_ID, role: 'patient', email: 'a@test.com' }];
  dbState.webhookEventIds = new Set();
  dbState.profileUpdates.length = 0;
});

describe('signature verification', () => {
  it('rejects a bad signature with 401', async () => {
    const res = await POST(buildRequest(approvedEvent(), { signature: 'deadbeef'.repeat(8) }));
    expect(res.status).toBe(401);
  });

  it('rejects an unsigned delivery with 401', async () => {
    const res = await POST(buildRequest(approvedEvent(), { skipSign: true }));
    expect(res.status).toBe(401);
  });

  it('rejects a stale timestamp with 401', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await POST(buildRequest(approvedEvent(), { timestamp: String(now - 1000) }));
    expect(res.status).toBe(401);
  });

  it('500s when DIDIT_WEBHOOK_SECRET is unset', async () => {
    delete process.env.DIDIT_WEBHOOK_SECRET;
    const res = await POST(buildRequest(approvedEvent()));
    expect(res.status).toBe(500);
  });
});

describe('idempotency', () => {
  it('processes a fresh event_id, then acknowledges a retried duplicate without reprocessing', async () => {
    const event = approvedEvent();
    const res1 = await POST(buildRequest(event));
    expect(res1.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('approved');

    dbState.profileUpdates.length = 0;
    const res2 = await POST(buildRequest(event));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.duplicate).toBe(true);
    expect(dbState.profileUpdates).toHaveLength(0);
  });
});

describe('Approved — writes sa_id_number + liveness_verified_at together', () => {
  it('persists on a valid, unclaimed SA ID', async () => {
    const res = await POST(buildRequest(approvedEvent()));
    expect(res.status).toBe(200);
    const row = dbState.profiles[0];
    expect(row.identity_verification_status).toBe('approved');
    expect(row.liveness_verified_at).toBeTruthy();
    expect(row.sa_id_number).toBeTruthy();
    expect(row.sa_id_lookup_hash).toBeTruthy();
  });

  it('declines when Didit returned no personal_number', async () => {
    const res = await POST(buildRequest(approvedEvent({
      decision: { id_verifications: [{ personal_number: null }] },
    })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('declined');
    expect(dbState.profiles[0].sa_id_number).toBeUndefined();
  });

  it('declines when the extracted ID fails validateSaId (bad checksum)', async () => {
    const res = await POST(buildRequest(approvedEvent({
      decision: { id_verifications: [{ personal_number: INVALID_SA_IDS[0].id }] },
    })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('declined');
    expect(dbState.profiles[0].sa_id_number).toBeUndefined();
  });

  it('declines when the extracted ID already belongs to a different account', async () => {
    const { hashIdForLookup } = await import('@/lib/idEncryption');
    dbState.profiles.push({
      id: 'other-user', role: 'patient', email: 'b@test.com',
      sa_id_lookup_hash: hashIdForLookup(VALID_SA_IDS[0]),
    });
    const res = await POST(buildRequest(approvedEvent()));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('declined');
    expect(dbState.profiles[0].sa_id_number).toBeUndefined();
  });

  it('is a no-op (not "declined") when it is a re-verification of the SAME account\'s existing ID', async () => {
    const { hashIdForLookup } = await import('@/lib/idEncryption');
    dbState.profiles[0].sa_id_lookup_hash = hashIdForLookup(VALID_SA_IDS[0]);
    const res = await POST(buildRequest(approvedEvent()));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('approved');
  });
});

describe('non-Approved statuses', () => {
  it.each([
    ['Declined', 'declined'],
    ['In Review', 'in_review'],
    ['Abandoned', 'abandoned'],
    ['Expired', 'expired'],
    ['Kyc Expired', 'expired'],
  ])('%s maps identity_verification_status to %s', async (diditStatus, expected) => {
    const res = await POST(buildRequest(approvedEvent({ event_id: `evt-${diditStatus}`, status: diditStatus, decision: null })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe(expected);
    expect(dbState.profiles[0].sa_id_number).toBeUndefined();
  });

  it('leaves the profile untouched for In Progress (still mid-flow)', async () => {
    const res = await POST(buildRequest(approvedEvent({ event_id: 'evt-inprog', status: 'In Progress', decision: null })));
    expect(res.status).toBe(200);
    expect(dbState.profileUpdates).toHaveLength(0);
  });
});

describe('malformed / unrelated deliveries', () => {
  it('400s on unparseable JSON', async () => {
    const req = new NextRequest('https://app.test/api/verification/didit/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('200s and ignores events with no vendor_data', async () => {
    const res = await POST(buildRequest(approvedEvent({ event_id: 'evt-novendor', vendor_data: null })));
    expect(res.status).toBe(200);
    expect(dbState.profileUpdates).toHaveLength(0);
  });
});
