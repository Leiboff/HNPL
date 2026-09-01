// SERVER-ONLY. Never import in a client component.

import crypto from 'node:crypto';

// ─── Peach Checkout webhook — HMAC-SHA256 signature verification ────
//
// Per developer.peachpayments.com/docs/checkout-webhooks + reference-
// webhooks (fetched 2026-07-17):
//
//   • Peach sends the INITIAL configuration webhook as JSON (this is
//     the registration handshake — the Dashboard requires the URL to
//     respond 200 for the URL to be accepted).
//
//   • All SUBSEQUENT event webhooks are `application/x-www-form-
//     urlencoded`. Payload is a query-string with fields like
//     `id`, `merchantTransactionId`, `result.code`, `card.last4Digits`,
//     `registrationId`, `standingInstruction.initialTransactionId`
//     (dotted names for nested fields).
//
//   • Signature (verbatim from the docs):
//         message   = `${timestamp}.${webhookId}.${url}.${payload}`
//         signature = HMAC-SHA256(secret, message)          → hex
//     Headers:
//         x-webhook-signature-algorithm   'HMAC-SHA256'
//         x-webhook-timestamp             delivery timestamp
//         x-webhook-id                    unique per delivery
//         x-webhook-signature             hex digest
//
//   • Key = the Checkout Secret Token from Dashboard → Checkout →
//     API keys (env: PEACH_CHECKOUT_SECRET_TOKEN). Same token used
//     for outbound request signing; no separate webhook secret exists.
//
//   • HMAC-SHA256 signing must be explicitly enabled by Peach support
//     on the merchant account. Until it is, deliveries arrive without
//     the signature headers — the caller decides posture per surface
//     (verification probe accepts unsigned; events require signature).

export type DecryptedWebhook = {
  /** Top-level event category. */
  type:    'PAYMENT' | 'REGISTRATION' | 'CHECKOUT' | string;
  /** For REGISTRATION / CHECKOUT lifecycle. */
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
  // Present on Checkout V2 event deliveries — the checkout that
  // produced this payment. Useful for reconciliation.
  checkoutId?:       string;
  // Echoed on REPEATED responses / events, pointing at the CIT root
  // of the credential chain. Kept as a nested object so parseFormEvent
  // can preserve the dotted path.
  standingInstruction?: {
    initialTransactionId?: string;
    mode?:                 string;
    source?:               string;
    type?:                 string;
  };
};

export type WebhookRegistrationPayload = {
  id?: string;              // Peach registration id
  merchantTransactionId?: string;
  card?: WebhookPaymentPayload['card'];
  result?: WebhookPaymentPayload['result'];
  customer?: { email?: string };
};

/**
 * Verify a Peach Checkout webhook signature.
 *
 * Signed message shape (per docs):
 *   `${timestamp}.${webhookId}.${url}.${payload}`
 *
 * `url` is the exact URL Peach POSTed to (i.e. the URL configured in
 * the Dashboard, verbatim — scheme + host + path + any query). The
 * caller supplies this because Next.js req.url is not reliable behind
 * Vercel's proxy; the definitive source is the env var
 * PEACH_CHECKOUT_WEBHOOK_URL that mirrors the Dashboard entry.
 *
 * Returns true iff the signature matches. Returns false on ANY
 * failure — missing headers, wrong algorithm, bad hex, length
 * mismatch, or a genuine non-match. Caller renders every false as 401.
 */
/**
 * How far x-webhook-timestamp may be from our clock before a delivery is
 * treated as stale. Matches lib/didit/webhook.ts's MAX_CLOCK_SKEW_SECONDS
 * — there is no reason for the two receivers to disagree about what
 * "recent" means, and having them agree is what makes the number
 * reviewable.
 *
 * This bound is why a captured delivery stops being replayable forever.
 * It is NOT the whole replay defence on its own: inside the window a
 * capture is still valid, which is what peach_webhook_events (0123) is
 * for. Freshness narrows the window; the ledger closes it.
 */
export const MAX_WEBHOOK_SKEW_SECONDS = 300;

/**
 * Parse Peach's x-webhook-timestamp and decide whether it is fresh.
 *
 * The docs show an ISO-8601 timestamp; other Peach surfaces use epoch
 * seconds. Both are accepted rather than guessed at, because getting this
 * wrong in the strict direction rejects every genuine delivery — a far
 * louder failure than the one it would be protecting against, and one that
 * would land in production rather than in review.
 *
 * An UNPARSEABLE timestamp is treated as fresh, not as stale. The value is
 * inside the signed message, so it cannot be forged without the secret;
 * refusing a shape we merely failed to anticipate would turn a format
 * change at Peach into a total payment-reconciliation outage.
 */
export function webhookTimestampIsFresh(
  timestamp: string | null,
  nowMs:     number = Date.now(),
): boolean {
  if (!timestamp) return false;

  const trimmed = timestamp.trim();
  let thenMs: number;

  if (/^\d{1,13}$/.test(trimmed)) {
    // Epoch. Ten digits or fewer is seconds; longer is milliseconds.
    const n = Number(trimmed);
    thenMs = trimmed.length <= 10 ? n * 1000 : n;
  } else {
    thenMs = Date.parse(trimmed);
  }

  if (!Number.isFinite(thenMs)) return true; // unrecognised shape — see above
  return Math.abs(nowMs - thenMs) <= MAX_WEBHOOK_SKEW_SECONDS * 1000;
}

export function verifyWebhookSignature(input: {
  body:      string;
  algorithm: string | null;
  timestamp: string | null;
  webhookId: string | null;
  url:       string | null;
  signature: string | null;
  secret:    string;
  /** Injectable for tests. Defaults to the real clock. */
  nowMs?:    number;
}): boolean {
  const { body, algorithm, timestamp, webhookId, url, signature, secret } = input;

  if (!secret) return false;
  if (!algorithm || !timestamp || !webhookId || !url || !signature) return false;
  if (algorithm !== 'HMAC-SHA256') return false;
  if (!webhookTimestampIsFresh(timestamp, input.nowMs)) return false;

  // Docs: message = `${timestamp}.${webhookId}.${url}.${payload}`.
  // `payload` == the raw request body, unmodified.
  const message = `${timestamp}.${webhookId}.${url}.${body}`;
  const expectedHex = crypto.createHmac('sha256', secret).update(message).digest('hex');

  // Hex-decode both sides and constant-time compare. Bad hex on the
  // header side is treated as a mismatch.
  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedHex,             'hex');
    providedBuf = Buffer.from(signature.toLowerCase(), 'hex');
  } catch {
    return false;
  }
  if (providedBuf.length === 0) return false;
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Parse the JSON body of an INITIAL configuration webhook. Returns
 * the raw object (not a DecryptedWebhook — the config delivery
 * doesn't carry {type, payload}; it carries setup metadata + the
 * verification code the Dashboard wants echoed back). Returns null on
 * parse failure so the caller can 400.
 */
export function parseConfigWebhookBody(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Parse an `application/x-www-form-urlencoded` event body into our
 * DecryptedWebhook shape. Peach uses DOTTED field names for nested
 * paths (e.g. `result.code=000.100.110`, `card.last4Digits=4242`,
 * `standingInstruction.initialTransactionId=xyz`).
 *
 * Returns null on parse failure or when the body carries no fields
 * we can classify.
 */
export function parseFormEventBody(body: string): DecryptedWebhook | null {
  if (!body) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(body);
  } catch {
    return null;
  }

  const flat: Record<string, string> = {};
  for (const [k, v] of params.entries()) flat[k] = v;
  if (Object.keys(flat).length === 0) return null;

  // Unflatten dotted names: 'result.code' → nested { result: { code } }.
  // Peach form deliveries use single-level dotting for the fields we
  // care about; deeper paths just get chained.
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let cursor: Record<string, unknown> = payload;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (typeof cursor[seg] !== 'object' || cursor[seg] === null) cursor[seg] = {};
      cursor = cursor[seg] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = value;
  }

  // Classify — Peach's form deliveries carry a `type` field on the
  // top-level event ('PAYMENT', 'REGISTRATION', 'CHECKOUT') OR imply
  // it from the presence of `id` + `result.code`. We look for the
  // explicit field first, then fall back to PAYMENT when a result.code
  // is present.
  const explicitType = typeof payload.type === 'string' ? (payload.type as string) : undefined;
  const explicitAction = typeof payload.action === 'string' ? (payload.action as string) : undefined;
  const hasResultCode = typeof (payload as { result?: { code?: unknown } }).result?.code === 'string';

  const type: string = explicitType ?? (hasResultCode ? 'PAYMENT' : 'UNKNOWN');
  const action: string | undefined = explicitAction;

  return {
    type,
    action,
    payload,
  };
}

// ─── Test hook — sign a body the same way Peach would. ─────────────
//
// Used ONLY by the webhook tests to build synthetic fixtures.

export function signWebhookForTesting(input: {
  body:       string;
  secret:     string;
  webhookId?: string;
  url?:       string;
  timestamp?: string;
}): {
  body:      string;
  algorithm: 'HMAC-SHA256';
  timestamp: string;
  webhookId: string;
  url:       string;
  signature: string;
} {
  const body      = input.body;
  // NOW, not a frozen literal. The default used to be '2026-07-17T12:00:00Z',
  // which was fine while nothing read the timestamp and became a suite that
  // fails on a wall-clock date the moment freshness started being checked.
  // A test that wants a stale delivery passes one explicitly.
  const timestamp = input.timestamp ?? new Date().toISOString();
  const webhookId = input.webhookId ?? 'wh_test_1';
  const url       = input.url       ?? 'https://app.test/api/payments/peach/webhook';
  const message   = `${timestamp}.${webhookId}.${url}.${body}`;
  const signature = crypto.createHmac('sha256', input.secret).update(message).digest('hex');
  return {
    body,
    algorithm: 'HMAC-SHA256',
    timestamp,
    webhookId,
    url,
    signature,
  };
}
