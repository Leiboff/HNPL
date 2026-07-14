import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import {
  verifyGoogleIdToken,
  __resetJwksCacheForTests,
  __primeJwksCacheForTests,
} from './oidcVerify';

// ─── OIDC verification — behavioural tests ────────────────────────
//
// Uses a locally-generated RSA-256 keypair to mint tokens with known
// claims, primes the JWKS cache with the JWK, then exercises every
// rejection path. NO network calls occur.

const AUDIENCE  = 'https://example.com/api/crm/gmail/push';
const SA_EMAIL  = 'gmail-push-sa@betternow-oauth.iam.gserviceaccount.com';
const KID       = 'test-key-1';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function generateKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const jwk = require('node:crypto').createPublicKey(publicKey).export({ format: 'jwk' });
  return { publicKey, privateKey, jwk };
}

function signJwt(privateKey: string, payload: Record<string, unknown>, kid = KID): string {
  const header  = { alg: 'RS256', typ: 'JWT', kid };
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  const input = `${h}.${p}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  const sig = signer.sign(privateKey);
  return `${input}.${b64url(sig)}`;
}

let keys: ReturnType<typeof generateKeys>;
const FIXED_NOW = 1_700_000_000_000;

beforeEach(() => {
  __resetJwksCacheForTests();
  keys = generateKeys();
  __primeJwksCacheForTests([
    {
      kid: KID,
      kty: keys.jwk.kty as string,
      alg: 'RS256',
      n:   keys.jwk.n as string,
      e:   keys.jwk.e as string,
      use: 'sig',
    },
  ]);
});

describe('verifyGoogleIdToken — success path', () => {
  it('accepts a token with correct iss / aud / email / exp and valid signature', async () => {
    const token = signJwt(keys.privateKey, {
      iss: 'https://accounts.google.com',
      aud: AUDIENCE,
      email: SA_EMAIL,
      email_verified: true,
      sub: 'sa-sub-1',
      exp: Math.floor(FIXED_NOW / 1000) + 300,
    });
    const r = await verifyGoogleIdToken(token, AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.email).toBe(SA_EMAIL);
      expect(r.claims.aud).toBe(AUDIENCE);
    }
  });

  it('accepts the bare-issuer form (accounts.google.com without https://)', async () => {
    const token = signJwt(keys.privateKey, {
      iss: 'accounts.google.com',
      aud: AUDIENCE, email: SA_EMAIL,
      exp: Math.floor(FIXED_NOW / 1000) + 300,
    });
    const r = await verifyGoogleIdToken(token, AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(true);
  });
});

describe('verifyGoogleIdToken — rejection paths', () => {
  it('missing token → missing_token', async () => {
    const r = await verifyGoogleIdToken('', AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('missing_token');
  });

  it('malformed token → malformed_token', async () => {
    const r = await verifyGoogleIdToken('not.a.jwt.at-all', AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('malformed_token');
  });

  it('wrong issuer → bad_issuer', async () => {
    const token = signJwt(keys.privateKey, {
      iss: 'https://evil.com', aud: AUDIENCE, email: SA_EMAIL,
      exp: Math.floor(FIXED_NOW / 1000) + 300,
    });
    const r = await verifyGoogleIdToken(token, AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('bad_issuer');
  });

  it('wrong audience → bad_audience', async () => {
    const token = signJwt(keys.privateKey, {
      iss: 'https://accounts.google.com', aud: 'https://someone.else', email: SA_EMAIL,
      exp: Math.floor(FIXED_NOW / 1000) + 300,
    });
    const r = await verifyGoogleIdToken(token, AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('bad_audience');
  });

  it('wrong email → bad_email', async () => {
    const token = signJwt(keys.privateKey, {
      iss: 'https://accounts.google.com', aud: AUDIENCE, email: 'attacker@evil.com',
      exp: Math.floor(FIXED_NOW / 1000) + 300,
    });
    const r = await verifyGoogleIdToken(token, AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('bad_email');
  });

  it('expired token → expired', async () => {
    const token = signJwt(keys.privateKey, {
      iss: 'https://accounts.google.com', aud: AUDIENCE, email: SA_EMAIL,
      exp: Math.floor(FIXED_NOW / 1000) - 60,
    });
    const r = await verifyGoogleIdToken(token, AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('expired');
  });

  it('unknown kid → unknown_kid', async () => {
    const token = signJwt(keys.privateKey, {
      iss: 'https://accounts.google.com', aud: AUDIENCE, email: SA_EMAIL,
      exp: Math.floor(FIXED_NOW / 1000) + 300,
    }, 'not-a-real-kid');
    const r = await verifyGoogleIdToken(token, AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('unknown_kid');
  });

  it('tampered signature → bad_signature', async () => {
    const token = signJwt(keys.privateKey, {
      iss: 'https://accounts.google.com', aud: AUDIENCE, email: SA_EMAIL,
      exp: Math.floor(FIXED_NOW / 1000) + 300,
    });
    // Flip a character in the signature portion.
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -3) + (parts[2].endsWith('A') ? 'B' : 'A') + parts[2].slice(-2)}`;
    const r = await verifyGoogleIdToken(tampered, AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('signed with a DIFFERENT key (same kid) → bad_signature', async () => {
    const other = generateKeys();
    // JWKS still primed with the original key, but token signed by other.
    const token = signJwt(other.privateKey, {
      iss: 'https://accounts.google.com', aud: AUDIENCE, email: SA_EMAIL,
      exp: Math.floor(FIXED_NOW / 1000) + 300,
    });
    const r = await verifyGoogleIdToken(token, AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects HS256 tokens (wrong alg)', async () => {
    // Build a token by hand with alg: HS256 but a valid RSA signature —
    // the alg check kicks in before signature verification.
    const header  = { alg: 'HS256', typ: 'JWT', kid: KID };
    const payload = {
      iss: 'https://accounts.google.com', aud: AUDIENCE, email: SA_EMAIL,
      exp: Math.floor(FIXED_NOW / 1000) + 300,
    };
    const h = b64url(Buffer.from(JSON.stringify(header)));
    const p = b64url(Buffer.from(JSON.stringify(payload)));
    const token = `${h}.${p}.AAAA`;
    const r = await verifyGoogleIdToken(token, AUDIENCE, SA_EMAIL, FIXED_NOW);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe('bad_alg');
  });
});
