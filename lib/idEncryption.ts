import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const KEY_ENV = 'SA_ID_ENCRYPTION_KEY';

function getKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(`${KEY_ENV} environment variable is not set`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(
      `${KEY_ENV} must decode to exactly 32 bytes (got ${key.byteLength}). ` +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return key;
}

/**
 * Encrypts a plaintext SA ID number with AES-256-GCM.
 *
 * Returns a versioned string:
 *   v1:<base64 iv>:<base64 authTag>:<base64 ciphertext>
 *
 * Each call generates a fresh random IV so the output is non-deterministic.
 * Throws if SA_ID_ENCRYPTION_KEY is missing or not 32 bytes when decoded.
 */
export function encryptId(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypts a value produced by encryptId.
 *
 * - Returns '' for null/empty input (safe to call on rows that haven't been
 *   migrated to encrypted storage yet).
 * - Throws on unknown version prefix, malformed format, or GCM auth failure
 *   (tampering / wrong key / corruption). Do not swallow — let it propagate.
 */
export function decryptId(stored: string): string {
  if (!stored) return '';

  const parts = stored.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted ID format: expected "version:iv:tag:ciphertext"');
  }

  const [version, ivB64, tagB64, ctB64] = parts;

  if (version !== 'v1') {
    throw new Error(`Unknown encryption version: "${version}". Only "v1" is supported.`);
  }

  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Returns the masked display form of a plaintext SA ID number (last 4 visible).
 * Pure string util — no crypto. Mirrors the pattern already used on the provider
 * profile page.
 */
export function maskId(plaintext: string): string {
  if (!plaintext) return '—';
  return `•••••••••${plaintext.slice(-4)}`;
}

/**
 * Safe display helper for profile pages during the plaintext → encrypted
 * migration period. Handles three cases:
 *
 *   null / empty  → ''  (caller renders '—')
 *   starts with 'v1:' → decryptId(); on any failure logs and returns ''
 *   anything else → legacy plaintext row; returned as-is, no decryption
 *
 * Never throws. A corrupted ciphertext produces '' rather than crashing the
 * page that calls this.
 */
export function decryptIdForDisplay(stored: string | null | undefined): string {
  if (!stored) return '';
  if (!stored.startsWith('v1:')) return stored;
  try {
    return decryptId(stored);
  } catch (err) {
    console.error(
      '[decryptIdForDisplay] failed to decrypt SA ID:',
      err instanceof Error ? err.message : err,
    );
    return '';
  }
}
