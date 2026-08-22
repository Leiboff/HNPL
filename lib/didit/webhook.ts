// SERVER-ONLY. Never import in a client component.

import crypto from 'node:crypto';

// ─── Didit webhook — canonical-V2 HMAC-SHA256 signature verification ───
//
// Per docs.didit.me/integration/webhooks:
//
//   • Three signature headers ship on every delivery; we verify
//     X-Signature-V2 — it's computed over a re-serialised canonical form
//     of the parsed body, so it survives whatever JSON middleware does to
//     the request (unlike X-Signature, which signs the raw bytes verbatim).
//
//   • Canonicalisation: shortenFloats (whole-number floats → integers) →
//     sortKeys (recursive, lexicographic; arrays keep their order) →
//     JSON.stringify (unescaped Unicode, the JS default).
//
//   • expected = HMAC-SHA256(DIDIT_WEBHOOK_SECRET, canonical, "utf8"), hex.
//
//   • Replay guard: reject if the delivery's X-Timestamp is more than
//     MAX_CLOCK_SKEW_SECONDS away from now.

function shortenFloats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shortenFloats);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shortenFloats(v)]),
    );
  }
  if (typeof value === 'number' && Number.isFinite(value) && value % 1 === 0) return Math.trunc(value);
  return value;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as object)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

function canonicalize(parsedBody: unknown): string {
  return JSON.stringify(sortKeys(shortenFloats(parsedBody)));
}

const MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Verify a Didit webhook delivery's X-Signature-V2.
 *
 * Returns false on ANY failure — missing secret/signature/timestamp,
 * stale timestamp, bad hex, length mismatch, or a genuine non-match.
 * Caller renders every false as 401.
 */
export function verifyDiditWebhookSignature(input: {
  parsedBody: unknown;
  signature:  string | null;
  timestamp:  string | null;
  secret:     string;
  /** Injectable for tests. Defaults to the real clock. */
  now?:       number;
}): boolean {
  const { parsedBody, signature, timestamp, secret } = input;
  if (!secret || !signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_SECONDS) return false;

  const canonical = canonicalize(parsedBody);
  const expectedHex = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');

  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedHex, 'hex');
    providedBuf = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (providedBuf.length === 0) return false;
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// ─── Test hook — sign a body the same way Didit would. ─────────────────

export function signDiditWebhookForTesting(input: {
  body:      unknown;
  secret:    string;
  timestamp?: string;
}): { signature: string; timestamp: string } {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const canonical = canonicalize(input.body);
  const signature = crypto.createHmac('sha256', input.secret).update(canonical, 'utf8').digest('hex');
  return { signature, timestamp };
}
