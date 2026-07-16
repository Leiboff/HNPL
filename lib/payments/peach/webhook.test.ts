import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  verifyWebhookSignature,
  parseWebhookBody,
  signWebhookForTesting,
  type DecryptedWebhook,
} from './webhook';

// ─── Peach Checkout V2 webhook HMAC-SHA256 signature tests ──────────
//
// The signWebhookForTesting helper builds a payload exactly the way
// Peach would (canonicalisation = `${timestamp}.${body}`). The verify
// side runs the identical canonicalisation in constant-time and
// returns true iff the digest matches. Tamper tests flip one byte and
// assert we reject.

function randomSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

const SAMPLE_PAYMENT_PAYLOAD: DecryptedWebhook = {
  type: 'PAYMENT',
  payload: {
    id: 'peach-payment-abc',
    merchantTransactionId: 'hnpl_co_abc123',
    amount: '92.00',
    currency: 'ZAR',
    paymentType: 'DB',
    result: { code: '000.100.110', description: 'Successfully processed' },
    card: {
      bin:          '424242',
      last4Digits:  '4242',
      holder:       'Test Cardholder',
      expiryMonth:  '12',
      expiryYear:   '2030',
      paymentBrand: 'VISA',
    },
    registrationId: 'peach-reg-abc',
    checkoutId:     'chk-abc',
  },
};

describe('verifyWebhookSignature — happy path (HMAC-SHA256)', () => {
  it('accepts a signed PAYMENT event round-trip', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ payload: SAMPLE_PAYMENT_PAYLOAD, secret });
    const ok = verifyWebhookSignature({
      body:      signed.body,
      algorithm: signed.algorithm,
      timestamp: signed.timestamp,
      signature: signed.signature,
      secret,
    });
    expect(ok).toBe(true);
    const parsed = parseWebhookBody(signed.body);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('PAYMENT');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parsed!.payload as any).merchantTransactionId).toBe('hnpl_co_abc123');
  });

  it('accepts a signed REGISTRATION event', () => {
    const secret = randomSecret();
    const payload: DecryptedWebhook = {
      type: 'REGISTRATION',
      action: 'CREATED',
      payload: { id: 'reg-1' },
    };
    const signed = signWebhookForTesting({ payload, secret });
    expect(verifyWebhookSignature({ ...signed, secret })).toBe(true);
    expect(parseWebhookBody(signed.body)).toEqual(payload);
  });

  it('accepts uppercase hex signatures (case-insensitive on the signature side)', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ payload: SAMPLE_PAYMENT_PAYLOAD, secret });
    const ok = verifyWebhookSignature({
      ...signed,
      signature: signed.signature.toUpperCase(),
      secret,
    });
    expect(ok).toBe(true);
  });
});

describe('verifyWebhookSignature — tamper resistance', () => {
  const secret = randomSecret();
  const signed = signWebhookForTesting({ payload: SAMPLE_PAYMENT_PAYLOAD, secret });

  it('rejects a flipped signature byte', () => {
    const bad = Buffer.from(signed.signature, 'hex');
    bad[0] = bad[0] ^ 0xff;
    expect(verifyWebhookSignature({
      ...signed,
      signature: bad.toString('hex'),
      secret,
    })).toBe(false);
  });

  it('rejects a body tampered after signing', () => {
    const tampered = signed.body.replace('92.00', '10.00');
    expect(verifyWebhookSignature({
      ...signed,
      body: tampered,
      secret,
    })).toBe(false);
  });

  it('rejects a mismatched timestamp (recomputed canonical does not match)', () => {
    expect(verifyWebhookSignature({
      ...signed,
      timestamp: '2001-01-01T00:00:00Z',
      secret,
    })).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const wrong = randomSecret();
    expect(verifyWebhookSignature({ ...signed, secret: wrong })).toBe(false);
  });

  it('rejects a non-HMAC-SHA256 algorithm header', () => {
    expect(verifyWebhookSignature({ ...signed, algorithm: 'HMAC-SHA1', secret })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, algorithm: 'plaintext', secret })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, algorithm: null, secret })).toBe(false);
  });

  it('rejects missing headers / body / secret', () => {
    expect(verifyWebhookSignature({ ...signed, timestamp: null, secret })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, signature: null, secret })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, body: '', secret })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, secret: '' })).toBe(false);
  });

  it('rejects a length-mismatched signature without throwing', () => {
    // 32-char (16-byte) HMAC — half the expected 64-char SHA256 digest.
    // The old implementation might have thrown from timingSafeEqual;
    // we return false cleanly.
    expect(verifyWebhookSignature({
      ...signed,
      signature: crypto.randomBytes(16).toString('hex'),
      secret,
    })).toBe(false);
  });

  it('rejects garbage hex on the signature header', () => {
    expect(verifyWebhookSignature({
      ...signed,
      signature: 'not-hex-at-all-zzz',
      secret,
    })).toBe(false);
  });
});

describe('parseWebhookBody', () => {
  it('parses a well-formed body', () => {
    const body = JSON.stringify({ type: 'PAYMENT', payload: { id: 'p1' } });
    expect(parseWebhookBody(body)).toEqual({ type: 'PAYMENT', payload: { id: 'p1' } });
  });

  it('returns null on non-JSON', () => {
    expect(parseWebhookBody('not json')).toBeNull();
  });

  it('returns null on missing required fields', () => {
    expect(parseWebhookBody('{}')).toBeNull();
    expect(parseWebhookBody('{"type":"PAYMENT"}')).toBeNull();
    expect(parseWebhookBody('{"payload":{}}')).toBeNull();
  });
});
