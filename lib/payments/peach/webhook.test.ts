import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  verifyWebhookSignature,
  parseConfigWebhookBody,
  parseFormEventBody,
  signWebhookForTesting,
  webhookTimestampIsFresh,
} from './webhook';

// ─── Peach Checkout webhook — verification + signature tests ────────
//
// Two surfaces:
//   • Verification probe — JSON body, may be UNSIGNED.
//   • Event delivery — form-urlencoded body, HMAC-SHA256-signed.
//
// Canonical message (verbatim from docs):
//   `${timestamp}.${webhookId}.${url}.${payload}`

function randomSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

const EVENT_BODY_SUCCESS =
  'id=peach-payment-abc' +
  '&merchantTransactionId=hnpl_co_abc123' +
  '&amount=92.00' +
  '&currency=ZAR' +
  '&paymentType=DB' +
  '&result.code=000.100.110' +
  '&result.description=Successfully%20processed' +
  '&card.last4Digits=4242' +
  '&card.paymentBrand=VISA' +
  '&card.expiryMonth=12' +
  '&card.expiryYear=2030' +
  '&registrationId=peach-reg-abc' +
  '&checkoutId=chk-abc' +
  '&type=PAYMENT';

describe('verifyWebhookSignature — canonical is ${timestamp}.${webhookId}.${url}.${payload}', () => {
  it('accepts a signed event round-trip built by signWebhookForTesting', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret });
    expect(verifyWebhookSignature({
      body:      signed.body,
      algorithm: signed.algorithm,
      timestamp: signed.timestamp,
      webhookId: signed.webhookId,
      url:       signed.url,
      signature: signed.signature,
      secret,
    })).toBe(true);
  });

  it('signature covers webhookId — flipping it invalidates', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret });
    expect(verifyWebhookSignature({
      ...signed,
      webhookId: 'different-webhook-id',
      secret,
    })).toBe(false);
  });

  it('signature covers url — flipping it invalidates', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret });
    expect(verifyWebhookSignature({
      ...signed,
      url: 'https://attacker.example/api/payments/peach/webhook',
      secret,
    })).toBe(false);
  });

  it('signature covers timestamp — flipping it invalidates', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret });
    expect(verifyWebhookSignature({
      ...signed,
      timestamp: '2001-01-01T00:00:00Z',
      secret,
    })).toBe(false);
  });

  it('signature covers body — tampering invalidates', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret });
    const tampered = signed.body.replace('92.00', '10.00');
    expect(verifyWebhookSignature({
      ...signed,
      body: tampered,
      secret,
    })).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret });
    expect(verifyWebhookSignature({ ...signed, secret: randomSecret() })).toBe(false);
  });

  it('rejects non-HMAC-SHA256 algorithm', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret });
    expect(verifyWebhookSignature({ ...signed, algorithm: 'HMAC-SHA1', secret })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, algorithm: null,      secret })).toBe(false);
  });

  it('rejects missing headers or missing secret', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret });
    expect(verifyWebhookSignature({ ...signed, timestamp: null, secret })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, webhookId: null, secret })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, url:       null, secret })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, signature: null, secret })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, secret: '' })).toBe(false);
  });

  it('accepts uppercase hex on the signature header (case-insensitive)', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret });
    expect(verifyWebhookSignature({
      ...signed,
      signature: signed.signature.toUpperCase(),
      secret,
    })).toBe(true);
  });

  it('rejects a length-mismatched signature without throwing', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret });
    expect(verifyWebhookSignature({
      ...signed,
      signature: crypto.randomBytes(16).toString('hex'), // half length
      secret,
    })).toBe(false);
  });

  it('rejects garbage-hex on the signature header', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({ body: EVENT_BODY_SUCCESS, secret });
    expect(verifyWebhookSignature({
      ...signed,
      signature: 'not-hex-at-all',
      secret,
    })).toBe(false);
  });
});

describe('parseConfigWebhookBody — JSON verification-probe payload', () => {
  it('parses a well-formed JSON object', () => {
    const body = JSON.stringify({ code: 'VERIFY-1234', event: 'setup' });
    expect(parseConfigWebhookBody(body)).toEqual({ code: 'VERIFY-1234', event: 'setup' });
  });

  it('returns null on non-JSON', () => {
    expect(parseConfigWebhookBody('not json')).toBeNull();
    expect(parseConfigWebhookBody('')).toBeNull();
  });

  it('returns null on JSON arrays / non-objects', () => {
    expect(parseConfigWebhookBody('[1,2,3]')).toBeNull();
    expect(parseConfigWebhookBody('"just a string"')).toBeNull();
    expect(parseConfigWebhookBody('42')).toBeNull();
  });
});

describe('parseFormEventBody — form-urlencoded event with dotted names', () => {
  it('parses a PAYMENT success event, unflattening dotted paths', () => {
    const parsed = parseFormEventBody(EVENT_BODY_SUCCESS);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('PAYMENT');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = parsed!.payload as any;
    expect(p.id).toBe('peach-payment-abc');
    expect(p.merchantTransactionId).toBe('hnpl_co_abc123');
    expect(p.amount).toBe('92.00');
    expect(p.result.code).toBe('000.100.110');
    expect(p.result.description).toBe('Successfully processed');
    expect(p.card.last4Digits).toBe('4242');
    expect(p.card.paymentBrand).toBe('VISA');
    expect(p.registrationId).toBe('peach-reg-abc');
    expect(p.checkoutId).toBe('chk-abc');
  });

  it('infers type=PAYMENT from presence of result.code when type field absent', () => {
    const body = 'id=x&result.code=000.100.110&merchantTransactionId=r1';
    const parsed = parseFormEventBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('PAYMENT');
  });

  it('preserves an explicit REGISTRATION type + action', () => {
    const body = 'type=REGISTRATION&action=DELETED&id=reg-1';
    const parsed = parseFormEventBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('REGISTRATION');
    expect(parsed!.action).toBe('DELETED');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parsed!.payload as any).id).toBe('reg-1');
  });

  it('extracts standingInstruction.initialTransactionId (dotted-name unflatten)', () => {
    const body = 'id=pay-1&result.code=000.100.110&standingInstruction.initialTransactionId=CIT-ROOT-1';
    const parsed = parseFormEventBody(body);
    expect(parsed).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = parsed!.payload as any;
    expect(p.standingInstruction.initialTransactionId).toBe('CIT-ROOT-1');
  });

  it('URL-decodes values', () => {
    const body = 'result.description=Payment%20failed%3A%20insufficient%20funds&id=x&result.code=800.100.152';
    const parsed = parseFormEventBody(body);
    expect(parsed).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parsed!.payload as any).result.description).toBe('Payment failed: insufficient funds');
  });

  it('returns null on empty body', () => {
    expect(parseFormEventBody('')).toBeNull();
  });
});

describe('signWebhookForTesting — round-trip integrity', () => {
  it('produces headers that verifyWebhookSignature accepts with a matching secret', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({
      body:      EVENT_BODY_SUCCESS,
      secret,
      webhookId: 'wh_test_custom',
      url:       'https://custom.example/hook',
      timestamp: '2026-07-17T09:00:00Z',
    });
    expect(signed.algorithm).toBe('HMAC-SHA256');
    expect(signed.webhookId).toBe('wh_test_custom');
    expect(signed.url).toBe('https://custom.example/hook');
    expect(signed.timestamp).toBe('2026-07-17T09:00:00Z');
    // nowMs pinned to the signed instant. This test is about the HMAC
    // round-trip, and the timestamp it deliberately fixes is now also read
    // by the freshness gate — without pinning the clock it would start
    // failing purely because the literal aged out, which says nothing
    // about signing. Freshness has its own tests below.
    expect(verifyWebhookSignature({
      ...signed,
      secret,
      nowMs: Date.parse('2026-07-17T09:00:00Z'),
    })).toBe(true);
  });
});

// ─── Timestamp freshness (audit F-09b) ──────────────────────────────────
//
// The signature covers the timestamp, so a captured delivery used to
// verify forever — the header was checked for PRESENCE and never read.
// These pin the window and, just as importantly, pin the two deliberate
// leniencies: an unrecognised timestamp SHAPE is accepted (a format change
// at Peach must not become a reconciliation outage) and epoch seconds are
// accepted alongside ISO-8601 (Peach's own surfaces disagree).

describe('webhookTimestampIsFresh', () => {
  const NOW = Date.parse('2026-09-01T12:00:00Z');

  it('accepts a delivery signed just now', () => {
    expect(webhookTimestampIsFresh('2026-09-01T12:00:00Z', NOW)).toBe(true);
  });

  it('accepts a delivery inside the skew window in both directions', () => {
    expect(webhookTimestampIsFresh('2026-09-01T11:56:00Z', NOW)).toBe(true);
    expect(webhookTimestampIsFresh('2026-09-01T12:04:00Z', NOW)).toBe(true);
  });

  it('rejects a delivery older than the skew window — the replay case', () => {
    expect(webhookTimestampIsFresh('2026-09-01T11:50:00Z', NOW)).toBe(false);
    expect(webhookTimestampIsFresh('2026-07-17T12:00:00Z', NOW)).toBe(false);
  });

  it('rejects a delivery further ahead than the skew window', () => {
    expect(webhookTimestampIsFresh('2026-09-01T12:10:00Z', NOW)).toBe(false);
  });

  it('reads epoch seconds and epoch milliseconds', () => {
    expect(webhookTimestampIsFresh(String(Math.floor(NOW / 1000)), NOW)).toBe(true);
    expect(webhookTimestampIsFresh(String(NOW), NOW)).toBe(true);
    expect(webhookTimestampIsFresh(String(Math.floor(NOW / 1000) - 3600), NOW)).toBe(false);
  });

  it('accepts an unparseable timestamp rather than refusing a signed delivery', () => {
    // Deliberate: the value is inside the signed message, so it cannot be
    // forged. Refusing a shape we merely failed to anticipate would take
    // down payment reconciliation over a formatting change.
    expect(webhookTimestampIsFresh('not-a-timestamp', NOW)).toBe(true);
  });

  it('rejects a missing timestamp', () => {
    expect(webhookTimestampIsFresh(null, NOW)).toBe(false);
  });
});

describe('verifyWebhookSignature — freshness is part of verification', () => {
  it('refuses a correctly-signed but stale delivery', () => {
    const secret = randomSecret();
    const signed = signWebhookForTesting({
      body:      EVENT_BODY_SUCCESS,
      secret,
      timestamp: '2026-09-01T12:00:00Z',
    });
    // Same bytes, same secret, same signature — six minutes later.
    expect(verifyWebhookSignature({
      ...signed,
      secret,
      nowMs: Date.parse('2026-09-01T12:06:00Z'),
    })).toBe(false);
    expect(verifyWebhookSignature({
      ...signed,
      secret,
      nowMs: Date.parse('2026-09-01T12:04:00Z'),
    })).toBe(true);
  });
});
