// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signWebhookForTesting } from '@/lib/payments/peach/webhook';

// ─── Peach Checkout webhook route — surface-level integration tests ─
//
// Two posture surfaces:
//   • Verification probe (JSON): 200 + logs the code, regardless of
//     signature state or PEACH_CHECKOUT_SECRET_TOKEN.
//   • Event (form-urlencoded): HMAC verified against
//       `${timestamp}.${webhookId}.${url}.${payload}`.
//     Bad / missing signature → 401. Good signature → parsed and
//     dispatched, always 200.
//
// The DB layer is fully mocked — this suite is about the route's
// signature / parsing / control-flow, not the state-flip handlers
// (those are pinned by settle-actions/webhook tests).

// ─── Supabase mock ─────────────────────────────────────────────────

type UpdateWrite  = { table: string; op: 'update'; row: unknown };
type InsertWrite  = { table: string; op: 'insert'; row: unknown };
type Write        = UpdateWrite | InsertWrite;

const dbState: {
  writes:   Write[];
  payments: Array<Record<string, unknown>>;
  plans:    Array<Record<string, unknown>>;
} = { writes: [], payments: [], plans: [] };

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from(table: string) {
      function selectChain() {
        const filters: Array<(row: Record<string, unknown>) => boolean> = [];
        const builder = {
          select() { return builder; },
          eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
          neq(col: string, val: unknown) { filters.push((r) => r[col] !== val); return builder; },
          is(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
          maybeSingle: async () => {
            const rows = (dbState as unknown as Record<string, Record<string, unknown>[]>)[table] ?? [];
            return { data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null };
          },
          single: async () => {
            const rows = (dbState as unknown as Record<string, Record<string, unknown>[]>)[table] ?? [];
            return { data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null };
          },
          // For .select('id').eq(...).neq(...).etc — chain terminator
          // that returns an array; used by the remaining-payments check.
          then: undefined,
        };
        return builder;
      }
      return {
        select: selectChain,
        update: (row: unknown) => {
          const b = {
            eq: () => b,
            is: () => b,
            select: () => Promise.resolve({ data: [], error: null }),
          };
          dbState.writes.push({ table, op: 'update', row });
          return Promise.resolve({ data: null, error: null, ...b });
        },
        insert: (row: unknown) => {
          dbState.writes.push({ table, op: 'insert', row });
          return Promise.resolve({ data: null, error: null });
        },
        upsert: (row: unknown) => {
          dbState.writes.push({ table, op: 'update', row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  })),
}));

// Silence auxiliary integrations so a webhook run doesn't require
// them to be present.
vi.mock('@/lib/notifications/sendPush', () => ({ sendPushToUser: vi.fn(async () => undefined) }));
vi.mock('@/lib/payments/dunningNotifications', () => ({
  notifyAttemptFailed:     vi.fn(async () => undefined),
  notifyDefaulted:         vi.fn(async () => undefined),
  notifyRecoverySucceeded: vi.fn(async () => undefined),
}));
vi.mock('@/lib/payments/peach/saveCardForPatient', () => ({
  saveCardForPatient: vi.fn(async () => ({ kind: 'inserted', cardId: 'card-x' })),
}));

// Import AFTER mocks are wired.
import { POST } from './route';
import { saveCardForPatient } from '@/lib/payments/peach/saveCardForPatient';

const SECRET = 'test-secret-token-hex-does-not-need-to-be-real';
const WEBHOOK_URL = 'https://app.test/api/payments/peach/webhook';

beforeEach(() => {
  dbState.writes.length   = 0;
  dbState.payments.length = 0;
  dbState.plans.length    = 0;
  vi.mocked(saveCardForPatient).mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL   = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY  = 'service-role-test';
  process.env.PEACH_CHECKOUT_SECRET_TOKEN = SECRET;
  process.env.PEACH_CHECKOUT_WEBHOOK_URL  = WEBHOOK_URL;
});

function makeJsonRequest(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(WEBHOOK_URL, {
    method:  'POST',
    body,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

function makeFormRequest(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(WEBHOOK_URL, {
    method:  'POST',
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
  });
}

// ─── (A) Verification probe ─────────────────────────────────────────

describe('POST /api/payments/peach/webhook — JSON verification probe', () => {
  it('returns 200 for a small JSON body regardless of missing signature (registration handshake)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = JSON.stringify({ code: 'VERIFY-42', event: 'setup' });
    const req  = makeJsonRequest(body);
    const res  = await POST(req);
    expect(res.status).toBe(200);
    // Bounded, structured operator log (never the complete body).
    const emitted = logSpy.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(emitted).toContain('verification probe received');
    expect(emitted).toContain('VERIFY-42');
    logSpy.mockRestore();
  });

  it('logs only bounded metadata for a probe with an unrecognised code field', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Use a field name we do not recognise.
    const body = JSON.stringify({
      unexpectedFieldName: 'CODE-XYZ',
      nested: { anotherOddName: 'inner-value' },
    });
    const req = makeJsonRequest(body);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const emitted = logSpy.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(emitted).toContain('verification probe received');
    expect(emitted).toContain('unexpectedFieldName');
    expect(emitted).not.toContain('CODE-XYZ');
    expect(emitted).not.toContain('inner-value');
    logSpy.mockRestore();
  });

  it('still returns 200 when PEACH_CHECKOUT_SECRET_TOKEN is unset (chicken-and-egg)', async () => {
    delete process.env.PEACH_CHECKOUT_SECRET_TOKEN;
    const req = makeJsonRequest(JSON.stringify({ code: 'VERIFY-99' }));
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it('returns 400 when content-type claims JSON but body does not parse', async () => {
    const req = makeJsonRequest('this is not json at all {');
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rejects oversized unsigned JSON before logging or parsing it', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = makeJsonRequest(JSON.stringify({ code: 'x'.repeat(17_000) }));
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

// ─── (B) Event delivery — signature required ────────────────────────

const EVENT_BODY_SUCCESS =
  'id=peach-payment-abc' +
  '&merchantTransactionId=bnrreg0000000001' +  // compact card-registration ref (purpose 'r')
  '&amount=0.00' +
  '&currency=ZAR' +
  '&paymentType=DB' +
  '&result.code=000.100.110' +
  '&registrationId=peach-reg-abc' +
  '&card.last4Digits=4242' +
  '&card.paymentBrand=VISA' +
  '&card.expiryMonth=12' +
  '&card.expiryYear=2030' +
  '&customParameters%5BSHOPPER_patientId%5D=patient-1' +
  '&type=PAYMENT';

describe('POST /api/payments/peach/webhook — signed event delivery', () => {
  it('returns 401 for a form-urlencoded event with NO signature headers', async () => {
    const req = makeFormRequest(EVENT_BODY_SUCCESS);
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 for a form-urlencoded event with a TAMPERED signature', async () => {
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret: SECRET, url: WEBHOOK_URL });
    const req = makeFormRequest(EVENT_BODY_SUCCESS, {
      'x-webhook-signature-algorithm': signed.algorithm,
      'x-webhook-timestamp':           signed.timestamp,
      'x-webhook-id':                  signed.webhookId,
      // Flip one hex char to invalidate.
      'x-webhook-signature':           signed.signature.slice(0, -1) + (signed.signature.slice(-1) === '0' ? '1' : '0'),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 and processes a validly-signed PAYMENT event', async () => {
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret: SECRET, url: WEBHOOK_URL });
    const req = makeFormRequest(EVENT_BODY_SUCCESS, {
      'x-webhook-signature-algorithm': signed.algorithm,
      'x-webhook-timestamp':           signed.timestamp,
      'x-webhook-id':                  signed.webhookId,
      'x-webhook-signature':           signed.signature,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
  });

  it('P2: card-reg backstop resolves the patient from BRACKETED-FLAT customParameters and saves the card', async () => {
    // Peach delivers customParameters[SHOPPER_patientId]=patient-1 as a
    // bracketed-flat key; parseFormEventBody keeps it flat. The handler
    // must read that literal key (not a nested customParameters object,
    // which the parser never builds) — else the backstop silently no-ops
    // (audit finding #4 / P2). Assert saveCardForPatient is called with
    // the resolved patientId.
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret: SECRET, url: WEBHOOK_URL });
    const res = await POST(makeFormRequest(EVENT_BODY_SUCCESS, {
      'x-webhook-signature-algorithm': signed.algorithm,
      'x-webhook-timestamp':           signed.timestamp,
      'x-webhook-id':                  signed.webhookId,
      'x-webhook-signature':           signed.signature,
    }));
    expect(res.status).toBe(200);
    expect(vi.mocked(saveCardForPatient)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveCardForPatient).mock.calls[0][0]).toBe('patient-1');
    expect(vi.mocked(saveCardForPatient).mock.calls[0][1]).toMatchObject({ registrationId: 'peach-reg-abc' });
  });

  it('is idempotent — double-delivery of the same signed event still returns 200', async () => {
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret: SECRET, url: WEBHOOK_URL });
    const headers = {
      'x-webhook-signature-algorithm': signed.algorithm,
      'x-webhook-timestamp':           signed.timestamp,
      'x-webhook-id':                  signed.webhookId,
      'x-webhook-signature':           signed.signature,
    };
    const first  = await POST(makeFormRequest(EVENT_BODY_SUCCESS, headers));
    const second = await POST(makeFormRequest(EVENT_BODY_SUCCESS, headers));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('returns 400 on a signature-verified but unparseable body', async () => {
    // The body is a signed-but-empty-after-parse form: only garbage
    // that URLSearchParams treats as one key with no value.
    const junk = '';
    const signed = signWebhookForTesting({ body: junk, secret: SECRET, url: WEBHOOK_URL });
    const req = makeFormRequest(junk, {
      'x-webhook-signature-algorithm': signed.algorithm,
      'x-webhook-timestamp':           signed.timestamp,
      'x-webhook-id':                  signed.webhookId,
      'x-webhook-signature':           signed.signature,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 500 when secret is unset AND the delivery is a signed event (not JSON)', async () => {
    delete process.env.PEACH_CHECKOUT_SECRET_TOKEN;
    const req = makeFormRequest(EVENT_BODY_SUCCESS);
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});

// ─── (C) Signature covers webhookId + url (regression pin) ──────────

describe('POST /api/payments/peach/webhook — signature invariants', () => {
  it('a signature computed under a DIFFERENT url is rejected (401)', async () => {
    // Attacker replays a signed body from a different URL.
    const signed = signWebhookForTesting({
      body:   EVENT_BODY_SUCCESS,
      secret: SECRET,
      url:    'https://attacker.example/api/payments/peach/webhook',
    });
    const req = makeFormRequest(EVENT_BODY_SUCCESS, {
      'x-webhook-signature-algorithm': signed.algorithm,
      'x-webhook-timestamp':           signed.timestamp,
      'x-webhook-id':                  signed.webhookId,
      'x-webhook-signature':           signed.signature,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('a signature computed with a DIFFERENT webhookId is rejected (401)', async () => {
    const signed = signWebhookForTesting({
      body:      EVENT_BODY_SUCCESS,
      secret:    SECRET,
      url:       WEBHOOK_URL,
      webhookId: 'wh-original',
    });
    const req = makeFormRequest(EVENT_BODY_SUCCESS, {
      'x-webhook-signature-algorithm': signed.algorithm,
      'x-webhook-timestamp':           signed.timestamp,
      'x-webhook-id':                  'wh-substituted',
      'x-webhook-signature':           signed.signature,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
