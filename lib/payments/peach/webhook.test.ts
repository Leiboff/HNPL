import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { decryptWebhook, encryptWebhookForTesting, type DecryptedWebhook } from './webhook';

// ─── Peach webhook AES-256-GCM decrypt — behavioural + tamper tests ─

function randomKeyHex(): string {
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
  },
};

describe('decryptWebhook — happy path with synthetic AES-256-GCM fixture', () => {
  it('round-trips a PAYMENT event', () => {
    const keyHex = randomKeyHex();
    const enc = encryptWebhookForTesting({
      payload: SAMPLE_PAYMENT_PAYLOAD,
      keyHex,
    });
    const decrypted = decryptWebhook({
      ciphertext: enc.ciphertext,
      ivHex:      enc.ivHex,
      authTagHex: enc.authTagHex,
      keyHex,
    });
    expect(decrypted).not.toBeNull();
    expect(decrypted!.type).toBe('PAYMENT');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((decrypted!.payload as any).merchantTransactionId).toBe('hnpl_co_abc123');
  });

  it('round-trips a REGISTRATION event with action', () => {
    const keyHex = randomKeyHex();
    const payload: DecryptedWebhook = {
      type: 'REGISTRATION',
      action: 'CREATED',
      payload: { id: 'reg-1' },
    };
    const enc = encryptWebhookForTesting({ payload, keyHex });
    const decrypted = decryptWebhook({ ...enc, keyHex });
    expect(decrypted).toEqual(payload);
  });
});

describe('decryptWebhook — tamper resistance', () => {
  const keyHex = randomKeyHex();
  const enc = encryptWebhookForTesting({ payload: SAMPLE_PAYMENT_PAYLOAD, keyHex });

  it('returns null when ciphertext is flipped', () => {
    const tampered = Buffer.from(enc.ciphertext);
    tampered[0] = tampered[0] ^ 0xff;
    expect(decryptWebhook({ ...enc, ciphertext: tampered, keyHex })).toBeNull();
  });

  it('returns null when auth tag is flipped', () => {
    const badTag = Buffer.from(enc.authTagHex, 'hex');
    badTag[0] = badTag[0] ^ 0xff;
    expect(decryptWebhook({
      ...enc,
      authTagHex: badTag.toString('hex'),
      keyHex,
    })).toBeNull();
  });

  it('returns null when IV is flipped', () => {
    const badIv = Buffer.from(enc.ivHex, 'hex');
    badIv[0] = badIv[0] ^ 0xff;
    expect(decryptWebhook({
      ...enc,
      ivHex: badIv.toString('hex'),
      keyHex,
    })).toBeNull();
  });

  it('returns null when the wrong key is used', () => {
    const wrongKey = randomKeyHex();
    expect(decryptWebhook({ ...enc, keyHex: wrongKey })).toBeNull();
  });

  it('returns null on obviously plaintext body (no ciphertext)', () => {
    const plain = Buffer.from(JSON.stringify(SAMPLE_PAYMENT_PAYLOAD), 'utf8');
    expect(decryptWebhook({ ciphertext: plain, ivHex: enc.ivHex, authTagHex: enc.authTagHex, keyHex })).toBeNull();
  });

  it('rejects a bad-length key', () => {
    const shortKey = crypto.randomBytes(16).toString('hex');
    expect(decryptWebhook({ ...enc, keyHex: shortKey })).toBeNull();
  });

  it('rejects a bad-length auth tag', () => {
    const shortTag = crypto.randomBytes(8).toString('hex');
    expect(decryptWebhook({ ...enc, authTagHex: shortTag, keyHex })).toBeNull();
  });
});
