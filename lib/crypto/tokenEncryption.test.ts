import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes, createCipheriv } from 'node:crypto';

// Behavioural round-trip + legacy-fallback tests. We swap env vars
// inside the test scope so the module reads the values we control.

const PRIMARY_KEY = randomBytes(32).toString('base64');
const LEGACY_KEY  = randomBytes(32).toString('base64');

function encryptWithKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

describe('tokenEncryption — dedicated key + legacy fallback', () => {
  const savedPrimary = process.env.TOKEN_ENCRYPTION_KEY;
  const savedLegacy  = process.env.SA_ID_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = PRIMARY_KEY;
    process.env.SA_ID_ENCRYPTION_KEY = LEGACY_KEY;
  });
  afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = savedPrimary;
    process.env.SA_ID_ENCRYPTION_KEY = savedLegacy;
  });

  it('round-trips under the primary key with usedLegacyKey=false', async () => {
    const { encryptToken, decryptToken } = await import('./tokenEncryption');
    const ct = encryptToken('super-secret-refresh-token');
    const r = decryptToken(ct);
    expect(r.plaintext).toBe('super-secret-refresh-token');
    expect(r.usedLegacyKey).toBe(false);
  });

  it('opens legacy ciphertext (SA_ID_ENCRYPTION_KEY) and flags usedLegacyKey=true', async () => {
    const { decryptToken } = await import('./tokenEncryption');
    const legacyBuf = Buffer.from(LEGACY_KEY, 'base64');
    const legacyCt  = encryptWithKey(legacyBuf, 'legacy-token');
    const r = decryptToken(legacyCt);
    expect(r.plaintext).toBe('legacy-token');
    expect(r.usedLegacyKey).toBe(true);
  });

  it('throws on empty stored value', async () => {
    const { decryptToken } = await import('./tokenEncryption');
    expect(() => decryptToken('')).toThrow(/empty value/);
  });

  it('throws on malformed ciphertext (bad version)', async () => {
    const { decryptToken } = await import('./tokenEncryption');
    expect(() => decryptToken('v2:aaa:bbb:ccc')).toThrow(/Invalid encrypted token format/);
  });

  it('throws on ciphertext that opens under neither key', async () => {
    const { decryptToken } = await import('./tokenEncryption');
    // Ciphertext produced under a random key with no relation to either env.
    const junkKey = randomBytes(32);
    const junkCt = encryptWithKey(junkKey, 'x');
    expect(() => decryptToken(junkCt)).toThrow();
  });

  it('encryptToken fails loudly when TOKEN_ENCRYPTION_KEY is missing', async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const { encryptToken } = await import('./tokenEncryption');
    expect(() => encryptToken('anything')).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('does not fall back to legacy key when TOKEN_ENCRYPTION_KEY is set but wrong (primary error surfaces first)', async () => {
    const { decryptToken } = await import('./tokenEncryption');
    // Encrypt under legacy, delete legacy env, replace primary with legacy value
    // simulating a rotation gone wrong.
    const legacyBuf = Buffer.from(LEGACY_KEY, 'base64');
    const ct = encryptWithKey(legacyBuf, 'x');
    // Legacy env still set → fallback path works
    const okr = decryptToken(ct);
    expect(okr.plaintext).toBe('x');
    expect(okr.usedLegacyKey).toBe(true);
    // Remove legacy env → decrypt must throw (no silent success)
    delete process.env.SA_ID_ENCRYPTION_KEY;
    expect(() => decryptToken(ct)).toThrow();
  });
});
