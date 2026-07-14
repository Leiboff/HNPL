// ─── Google OIDC token verification ───────────────────────────────
//
// The Pub/Sub push subscription is configured with OIDC auth: every
// push request carries `Authorization: Bearer <id_token>`. We MUST
// verify that token before trusting the message body — otherwise
// anyone with the push URL could forge Gmail reply notifications.
//
// Verification steps:
//   1. Parse the JWT (header.payload.signature, all base64url).
//   2. Fetch Google's JWKS (rotated periodically; we cache).
//   3. Verify the signature under the JWK matching the token's kid.
//   4. Assert iss, aud, email, exp.
//
// We do NOT use `jose` or `jsonwebtoken` — these are unavailable in
// most runtimes without a dependency. Node's native `crypto.verify`
// handles RS256 given the JWK converted to a PEM-shaped KeyObject.

import { createPublicKey, verify as verifySig } from 'node:crypto';

const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS  = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
]);

// Simple in-memory JWKS cache (per-instance; Vercel serverless
// instances are short-lived so we re-fetch on cold start).
type Jwk = {
  kid: string;
  kty: string;
  alg: string;
  n:   string;
  e:   string;
  use: string;
};

let jwksCache: { fetchedAt: number; keys: Jwk[] } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;  // 1 h — Google's cache-control is longer but 1h is plenty

async function fetchJwks(): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(GOOGLE_JWKS_URI);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const parsed = await res.json() as { keys: Jwk[] };
  jwksCache = { fetchedAt: now, keys: parsed.keys };
  return parsed.keys;
}

/** Test-only: reset the JWKS cache between assertions. */
export function __resetJwksCacheForTests(): void {
  jwksCache = null;
}

/** Test-only: prime the JWKS cache with a canned key set. */
export function __primeJwksCacheForTests(keys: Jwk[]): void {
  jwksCache = { fetchedAt: Date.now(), keys };
}

function b64urlToBuf(s: string): Buffer {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export type VerifiedGooglePush = {
  email:  string;
  aud:    string;
  iss:    string;
  sub:    string;
  exp:    number;
};

export type VerifyResult =
  | { ok: true;  claims: VerifiedGooglePush }
  | { ok: false; reason: string };

/**
 * Verify a Google-signed OIDC ID token. Enforces:
 *   - iss   ∈ https://accounts.google.com | accounts.google.com
 *   - aud   === expectedAudience
 *   - email === expectedEmail
 *   - exp   > now
 *   - RS256 signature validates against the matching Google JWK
 */
export async function verifyGoogleIdToken(
  bearer: string,
  expectedAudience: string,
  expectedEmail: string,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  if (!bearer) return { ok: false, reason: 'missing_token' };
  const parts = bearer.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed_token' };
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string; typ?: string };
  let payload: {
    iss?:   string;
    aud?:   string;
    exp?:   number;
    sub?:   string;
    email?: string;
    email_verified?: boolean;
  };
  try {
    header  = JSON.parse(b64urlToBuf(headerB64).toString('utf8'));
    payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed_token' };
  }

  if (header.alg !== 'RS256') return { ok: false, reason: 'bad_alg' };
  if (!header.kid) return { ok: false, reason: 'missing_kid' };

  // Claim checks BEFORE signature verification are cheap and safe —
  // they don't leak signing material.
  if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) return { ok: false, reason: 'bad_issuer' };
  if (!payload.aud || payload.aud !== expectedAudience) return { ok: false, reason: 'bad_audience' };
  if (!payload.email || payload.email.toLowerCase() !== expectedEmail.toLowerCase()) return { ok: false, reason: 'bad_email' };
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };

  const jwks = await fetchJwks();
  const jwk  = jwks.find(k => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown_kid' };

  let keyObj;
  try {
    keyObj = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return { ok: false, reason: 'bad_jwk' };
  }

  const signedInput = `${headerB64}.${payloadB64}`;
  let sigOk = false;
  try {
    sigOk = verifySig(
      'RSA-SHA256',
      Buffer.from(signedInput, 'utf8'),
      keyObj,
      b64urlToBuf(sigB64),
    );
  } catch {
    return { ok: false, reason: 'sig_verify_error' };
  }
  if (!sigOk) return { ok: false, reason: 'bad_signature' };

  return {
    ok: true,
    claims: {
      email: payload.email!,
      aud:   payload.aud!,
      iss:   payload.iss!,
      sub:   payload.sub ?? '',
      exp:   payload.exp!,
    },
  };
}
