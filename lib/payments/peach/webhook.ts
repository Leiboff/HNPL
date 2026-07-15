// SERVER-ONLY. Never import in a client component.

import crypto from 'node:crypto';

// ─── Peach OPPWA webhook — AES-256-GCM payload decryption ───────────
//
// The Peach webhooks doc specifies:
//   • The body is AES-256-GCM encrypted with a 32-byte (64 hex char) key.
//   • The IV travels in the X-Initialization-Vector header (hex).
//   • The 16-byte auth tag travels in X-Authentication-Tag (hex).
//   • The plaintext is a JSON object with { type, action?, payload }.
//
// A single tampered byte anywhere (header IV, header tag, body) makes
// the GCM auth check fail; we surface that as `null` from the pure
// function and 401 from the route.
//
// The pure function below is safe to call anywhere — the caller
// supplies the ciphertext, headers, and secret hex string. All I/O
// (reading process.env, reading req.headers) happens in the route.

export type DecryptedWebhook = {
  /** Top-level event category. */
  type:    'PAYMENT' | 'REGISTRATION' | 'SCHEDULE' | 'RISK' | string;
  /** For REGISTRATION events. */
  action?: 'CREATED' | 'UPDATED' | 'DELETED' | string;
  /** The actual transaction body — shape depends on `type`. */
  payload: WebhookPaymentPayload | WebhookRegistrationPayload | Record<string, unknown>;
};

export type WebhookPaymentPayload = {
  id?:                    string;    // Peach payment id
  merchantTransactionId?: string;    // Our reference (used to reconcile)
  amount?:                string;
  currency?:               string;
  paymentType?:            string;
  paymentBrand?:           string;
  descriptor?:             string;
  result?: {
    code?:        string;
    description?: string;
  };
  card?: {
    bin?:          string;
    last4Digits?:  string;
    holder?:       string;
    expiryMonth?:  string;
    expiryYear?:   string;
    paymentBrand?: string;
    binCountry?:   string;
  };
  registrationId?: string;
  customer?: {
    email?: string;
  };
  customParameters?: Record<string, string>;
  timestamp?:        string;
};

export type WebhookRegistrationPayload = {
  id?: string;              // Peach registration id
  merchantTransactionId?: string;
  card?: WebhookPaymentPayload['card'];
  result?: WebhookPaymentPayload['result'];
  customer?: { email?: string };
};

/**
 * Decrypt an OPPWA webhook body. Pure function — takes hex strings
 * for the IV / auth-tag / key, and the raw ciphertext buffer.
 * Returns null on any failure (bad key, bad IV, tampered payload).
 */
export function decryptWebhook(input: {
  ciphertext: Buffer;
  ivHex:      string;
  authTagHex: string;
  keyHex:     string;
}): DecryptedWebhook | null {
  const { ciphertext, ivHex, authTagHex, keyHex } = input;

  if (!ivHex || !authTagHex || !keyHex || ciphertext.length === 0) return null;

  let key: Buffer;
  let iv:  Buffer;
  let tag: Buffer;
  try {
    key = Buffer.from(keyHex, 'hex');
    iv  = Buffer.from(ivHex,  'hex');
    tag = Buffer.from(authTagHex, 'hex');
  } catch {
    return null;
  }
  if (key.length !== 32) return null;
  if (iv.length  !== 12 && iv.length !== 16) return null;
  if (tag.length !== 16) return null;

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(decrypted) as DecryptedWebhook;
    if (!parsed || typeof parsed !== 'object' || !parsed.type || !parsed.payload) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Test hook — encrypt a payload the same way Peach would. Used ONLY by
// the webhook tests to build synthetic fixtures.
export function encryptWebhookForTesting(input: {
  payload:  DecryptedWebhook;
  keyHex:   string;
  ivHex?:   string;
}): { ciphertext: Buffer; ivHex: string; authTagHex: string } {
  const key = Buffer.from(input.keyHex, 'hex');
  if (key.length !== 32) throw new Error('encryptWebhookForTesting: key must be 32 bytes / 64 hex chars');
  const iv = input.ivHex ? Buffer.from(input.ivHex, 'hex') : crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(input.payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext,
    ivHex:     iv.toString('hex'),
    authTagHex: tag.toString('hex'),
  };
}
