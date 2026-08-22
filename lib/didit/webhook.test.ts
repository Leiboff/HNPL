import { describe, it, expect } from 'vitest';
import { verifyDiditWebhookSignature, signDiditWebhookForTesting } from './webhook';

const SECRET = 'test-webhook-secret';
const BODY = {
  event_id:   'evt_1',
  webhook_type: 'status.updated',
  status:     'Approved',
  vendor_data: 'user-123',
  timestamp:  1774970000,
};

describe('verifyDiditWebhookSignature', () => {
  it('accepts a correctly signed, fresh delivery', () => {
    const now = 1774970010;
    const { signature, timestamp } = signDiditWebhookForTesting({
      body: BODY, secret: SECRET, timestamp: String(now - 5),
    });
    expect(verifyDiditWebhookSignature({
      parsedBody: BODY, signature, timestamp, secret: SECRET, now,
    })).toBe(true);
  });

  it('is insensitive to key order (canonicalisation sorts keys)', () => {
    const now = 1774970010;
    const { signature, timestamp } = signDiditWebhookForTesting({
      body: BODY, secret: SECRET, timestamp: String(now - 5),
    });
    const reordered = { vendor_data: BODY.vendor_data, status: BODY.status, timestamp: BODY.timestamp, event_id: BODY.event_id, webhook_type: BODY.webhook_type };
    expect(verifyDiditWebhookSignature({
      parsedBody: reordered, signature, timestamp, secret: SECRET, now,
    })).toBe(true);
  });

  it('rejects a bad signature', () => {
    const now = 1774970010;
    expect(verifyDiditWebhookSignature({
      parsedBody: BODY, signature: 'deadbeef'.repeat(8), timestamp: String(now), secret: SECRET, now,
    })).toBe(false);
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const now = 1774970010;
    const { signature, timestamp } = signDiditWebhookForTesting({
      body: BODY, secret: SECRET, timestamp: String(now - 5),
    });
    const tampered = { ...BODY, status: 'Declined' };
    expect(verifyDiditWebhookSignature({
      parsedBody: tampered, signature, timestamp, secret: SECRET, now,
    })).toBe(false);
  });

  it('rejects a stale timestamp (replay protection)', () => {
    const now = 1774970010;
    const { signature, timestamp } = signDiditWebhookForTesting({
      body: BODY, secret: SECRET, timestamp: String(now - 400),
    });
    expect(verifyDiditWebhookSignature({
      parsedBody: BODY, signature, timestamp, secret: SECRET, now,
    })).toBe(false);
  });

  it('rejects missing signature, timestamp, or secret', () => {
    expect(verifyDiditWebhookSignature({ parsedBody: BODY, signature: null, timestamp: '1', secret: SECRET })).toBe(false);
    expect(verifyDiditWebhookSignature({ parsedBody: BODY, signature: 'ab', timestamp: null, secret: SECRET })).toBe(false);
    expect(verifyDiditWebhookSignature({ parsedBody: BODY, signature: 'ab', timestamp: '1', secret: '' })).toBe(false);
  });

  it('rejects non-hex signature without throwing', () => {
    const now = 1774970010;
    expect(verifyDiditWebhookSignature({
      parsedBody: BODY, signature: 'not-hex-zz', timestamp: String(now), secret: SECRET, now,
    })).toBe(false);
  });
});
