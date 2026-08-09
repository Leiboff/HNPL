import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import { encryptId, decryptId, maskId, decryptIdForDisplay, hashIdForLookup } from './idEncryption';

// ---------------------------------------------------------------------------
// Test key setup
//
// A fresh 32-byte key is generated at test-run time and injected into
// process.env before any test function executes. getKey() reads process.env
// at call time (not import time), so this ordering is safe.
//
// Never use the real production key here.
// ---------------------------------------------------------------------------

const ENV_VAR = 'SA_ID_ENCRYPTION_KEY';
const TEST_KEY_B64 = randomBytes(32).toString('base64');

const LOOKUP_ENV_VAR = 'SA_ID_LOOKUP_HMAC_KEY';
const TEST_LOOKUP_KEY_B64 = randomBytes(32).toString('base64');

// Realistic 13-digit South African ID number used throughout.
const SA_ID = '9001015800086';

beforeAll(() => {
  process.env[ENV_VAR] = TEST_KEY_B64;
  process.env[LOOKUP_ENV_VAR] = TEST_LOOKUP_KEY_B64;
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('encryptId / decryptId — round-trip', () => {
  it('decrypts back to the original 13-digit SA ID', () => {
    expect(decryptId(encryptId(SA_ID))).toBe(SA_ID);
  });

  it('round-trips an empty string (edge case)', () => {
    expect(decryptId(encryptId(''))).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Non-determinism (random IV)
// ---------------------------------------------------------------------------

describe('encryptId — non-determinism', () => {
  it('produces different ciphertext for the same plaintext', () => {
    const first  = encryptId(SA_ID);
    const second = encryptId(SA_ID);
    expect(first).not.toBe(second);
  });
});

// ---------------------------------------------------------------------------
// GCM authentication — tampering detection
// ---------------------------------------------------------------------------

describe('decryptId — GCM authentication', () => {
  it('throws when the ciphertext segment is tampered', () => {
    const encrypted = encryptId(SA_ID);
    const [v, ivB64, tagB64, ctB64] = encrypted.split(':');

    // Flip all bits in the first byte of the raw ciphertext, then re-encode.
    const ct = Buffer.from(ctB64, 'base64');
    ct[0] ^= 0xff;
    const tampered = [v, ivB64, tagB64, ct.toString('base64')].join(':');

    expect(() => decryptId(tampered)).toThrow();
  });

  it('throws when the auth tag is tampered', () => {
    const encrypted = encryptId(SA_ID);
    const [v, ivB64, tagB64, ctB64] = encrypted.split(':');

    const tag = Buffer.from(tagB64, 'base64');
    tag[0] ^= 0xff;
    const tampered = [v, ivB64, tag.toString('base64'), ctB64].join(':');

    expect(() => decryptId(tampered)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Version validation
// ---------------------------------------------------------------------------

describe('decryptId — version prefix', () => {
  it('throws on an unknown version prefix', () => {
    expect(() => decryptId('v2:abc:def:ghi')).toThrow(/Unknown encryption version/);
  });

  it('throws on a malformed string (wrong segment count)', () => {
    expect(() => decryptId('v1:onlythreesegments')).toThrow(/Invalid encrypted ID format/);
  });
});

// ---------------------------------------------------------------------------
// Null / empty input
// ---------------------------------------------------------------------------

describe('decryptId — null/empty input', () => {
  it('returns empty string for empty string input', () => {
    expect(decryptId('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

describe('key validation', () => {
  afterEach(() => {
    // Restore the valid test key so subsequent tests are unaffected.
    process.env[ENV_VAR] = TEST_KEY_B64;
  });

  it('throws a clear error naming the env var when the key is missing', () => {
    delete process.env[ENV_VAR];
    expect(() => encryptId(SA_ID)).toThrow(ENV_VAR);
  });

  it('throws mentioning "32 bytes" when the key is too short', () => {
    process.env[ENV_VAR] = Buffer.from('tooshort').toString('base64');
    expect(() => encryptId(SA_ID)).toThrow(/32 bytes/);
  });

  it('throws mentioning "32 bytes" when the key is too long', () => {
    // 64 bytes decodes to 64 — should still fail the length check.
    process.env[ENV_VAR] = randomBytes(64).toString('base64');
    expect(() => encryptId(SA_ID)).toThrow(/32 bytes/);
  });
});

// ---------------------------------------------------------------------------
// maskId
// ---------------------------------------------------------------------------

describe('maskId', () => {
  it('returns 9 bullets + last 4 digits', () => {
    // '9001015800086'.slice(-4) === '0086'
    expect(maskId(SA_ID)).toBe('•••••••••0086');
  });

  it('returns em-dash for an empty string', () => {
    expect(maskId('')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// decryptIdForDisplay — transitional safe display helper
// ---------------------------------------------------------------------------

describe('decryptIdForDisplay', () => {
  it('decrypts a v1: ciphertext to the original plaintext', () => {
    const encrypted = encryptId(SA_ID);
    expect(decryptIdForDisplay(encrypted)).toBe(SA_ID);
  });

  it('passes through a legacy plaintext value unchanged (no v1: prefix)', () => {
    expect(decryptIdForDisplay('9001015800086')).toBe('9001015800086');
  });

  it('returns empty string for null', () => {
    expect(decryptIdForDisplay(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(decryptIdForDisplay(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(decryptIdForDisplay('')).toBe('');
  });

  it('returns empty string for a corrupted v1: value (never throws)', () => {
    const encrypted = encryptId(SA_ID);
    const [v, ivB64, tagB64, ctB64] = encrypted.split(':');
    const ct = Buffer.from(ctB64, 'base64');
    ct[0] ^= 0xff;
    const corrupted = [v, ivB64, tagB64, ct.toString('base64')].join(':');
    expect(() => decryptIdForDisplay(corrupted)).not.toThrow();
    expect(decryptIdForDisplay(corrupted)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// hashIdForLookup — deterministic blind index (migration 0085)
// ---------------------------------------------------------------------------

describe('hashIdForLookup — determinism', () => {
  it('produces the SAME hash for the same plaintext (unlike encryptId)', () => {
    const first  = hashIdForLookup(SA_ID);
    const second = hashIdForLookup(SA_ID);
    expect(first).toBe(second);
  });

  it('produces different hashes for different plaintext', () => {
    expect(hashIdForLookup(SA_ID)).not.toBe(hashIdForLookup('8501015800087'));
  });

  it('is a 64-char lowercase hex string (SHA-256 digest)', () => {
    expect(hashIdForLookup(SA_ID)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashIdForLookup — key separation from SA_ID_ENCRYPTION_KEY', () => {
  it('uses a DIFFERENT key than encryptId — flipping the encryption key does not change the hash', () => {
    const before = hashIdForLookup(SA_ID);
    const savedEncKey = process.env[ENV_VAR];
    process.env[ENV_VAR] = randomBytes(32).toString('base64');
    const after = hashIdForLookup(SA_ID);
    process.env[ENV_VAR] = savedEncKey;
    expect(after).toBe(before);
  });

  it('flipping the lookup key DOES change the hash', () => {
    const before = hashIdForLookup(SA_ID);
    const saved = process.env[LOOKUP_ENV_VAR];
    process.env[LOOKUP_ENV_VAR] = randomBytes(32).toString('base64');
    const after = hashIdForLookup(SA_ID);
    process.env[LOOKUP_ENV_VAR] = saved;
    expect(after).not.toBe(before);
  });
});

describe('hashIdForLookup — key validation', () => {
  afterEach(() => {
    process.env[LOOKUP_ENV_VAR] = TEST_LOOKUP_KEY_B64;
  });

  it('throws a clear error naming the env var when the key is missing', () => {
    delete process.env[LOOKUP_ENV_VAR];
    expect(() => hashIdForLookup(SA_ID)).toThrow(LOOKUP_ENV_VAR);
  });

  it('throws mentioning "32 bytes" when the key is too short', () => {
    process.env[LOOKUP_ENV_VAR] = Buffer.from('tooshort').toString('base64');
    expect(() => hashIdForLookup(SA_ID)).toThrow(/32 bytes/);
  });
});
