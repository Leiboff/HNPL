// SERVER-ONLY. Never import in a client component.

import crypto from 'node:crypto';

// ─── Peach Checkout V2 webhook — HMAC-SHA256 signature verification ─
//
// V2 replaces the legacy OPPWA AES-256-GCM encrypted-body scheme with
// signed (unencrypted) JSON. Peach sends:
//
//   • Body                        — plaintext JSON:
//                                   { type, action?, payload }
//   • x-webhook-signature-algorithm — 'HMAC-SHA256'
//   • x-webhook-timestamp          — ISO-8601 or unix seconds
//   • x-webhook-signature          — hex-encoded HMAC digest
//
// Signature scheme:
//
//   expected = HMAC-SHA256(secret, `${timestamp}.${body}`)
//
// TODO(dina): confirm the exact canonicalisation format against the
// Checkout V2 webhooks doc / a Postman capture. The common Peach V2
// pattern is `${timestamp}.${rawBody}` — used below — but some Peach
// products sign the raw body alone. If a live sandbox delivery
// verifies with body-only, update the concat and the tests together.
//
// Rejection posture:
//   • The pure function returns null on:
//     - wrong algorithm header
//     - length-mismatched signature (would throw in timingSafeEqual)
//     - HMAC mismatch
//     - bad hex on the signature header
//     - empty body / empty signature
//   • The caller (webhook route) turns null → 401. Every OTHER failure
//     (payload we can't process, missing fields, DB write errors) is
//     caught and returned as 200 so Peach doesn't retry-storm us.

export type DecryptedWebhook = {
  /** Top-level event category (Checkout V2 uses these). */
  type:    'PAYMENT' | 'REGISTRATION' | 'SCHEDULE' | 'RISK' | 'CHECKOUT' | string;
  /** For REGISTRATION / CHECKOUT events. */
  action?: 'CREATED' | 'UPDATED' | 'DELETED' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED' | string;
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
  // V2 additions — the same webhook carries the checkoutId that
  // produced this payment, useful for reconciliation.
  checkoutId?:       string;
};

export type WebhookRegistrationPayload = {
  id?: string;              // Peach registration id
  merchantTransactionId?: string;
  card?: WebhookPaymentPayload['card'];
  result?: WebhookPaymentPayload['result'];
  customer?: { email?: string };
};

/**
 * Verify a V2 webhook signature. Pure function — the caller supplies
 * the raw body text, the three headers, and the shared secret.
 *
 * Returns `true` iff the signature matches. Returns `false` on ANY
 * failure — wrong algorithm, missing headers, length mismatch, bad
 * hex, or a genuinely non-matching signature. The caller does not need
 * to distinguish; every negative case is a 401.
 */
export function verifyWebhookSignature(input: {
  body:      string;
  algorithm: string | null;
  timestamp: string | null;
  signature: string | null;
  secret:    string;
}): boolean {
  const { body, algorithm, timestamp, signature, secret } = input;

  if (!body || !algorithm || !timestamp || !signature || !secret) return false;
  if (algorithm !== 'HMAC-SHA256') return false;

  // TODO(dina): confirm canonicalisation. Default: `${timestamp}.${body}`.
  const canonical = `${timestamp}.${body}`;
  const expectedHex = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

  // Hex-decode both sides and constant-time compare. Bad hex on the
  // header side is treated as a mismatch.
  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedHex,           'hex');
    providedBuf = Buffer.from(signature.toLowerCase(), 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Parse the JSON body into our DecryptedWebhook shape. Returns null
 * if the body isn't JSON or is missing the required `type` + `payload`
 * fields. Kept separate from verifyWebhookSignature so the caller can
 * verify FIRST and only parse if the signature was authentic.
 */
export function parseWebhookBody(body: string): DecryptedWebhook | null {
  try {
    const parsed = JSON.parse(body) as DecryptedWebhook;
    if (!parsed || typeof parsed !== 'object' || !parsed.type || !parsed.payload) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Test hook — sign a payload the same way Peach would. ──────────
//
// Used ONLY by the webhook tests to build synthetic fixtures. The
// implementation matches verifyWebhookSignature above; keeping the
// two functions in the same file makes canonicalisation changes
// impossible to make without updating both sides.

export function signWebhookForTesting(input: {
  payload:   DecryptedWebhook;
  secret:    string;
  timestamp?: string;
}): { body: string; algorithm: 'HMAC-SHA256'; timestamp: string; signature: string } {
  const body      = JSON.stringify(input.payload);
  const timestamp = input.timestamp ?? '2026-07-16T12:00:00Z';
  const canonical = `${timestamp}.${body}`;
  const signature = crypto.createHmac('sha256', input.secret).update(canonical).digest('hex');
  return { body, algorithm: 'HMAC-SHA256', timestamp, signature };
}
