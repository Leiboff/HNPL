import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// ─── Token encryption — dedicated key with legacy fallback ────────────
//
// AES-256-GCM. Same v1:<iv>:<tag>:<ct> ciphertext format as
// lib/idEncryption.ts — a value produced by encryptToken is
// self-describing at decrypt time.
//
// Keys:
//   • TOKEN_ENCRYPTION_KEY — primary. Required. Fail loud on missing.
//   • SA_ID_ENCRYPTION_KEY — legacy fallback for tokens encrypted
//     BEFORE the key split. Rows encrypted under this key are opened
//     transparently by decryptToken (returns { usedLegacyKey: true })
//     and re-encrypted under the primary key on the next successful
//     token refresh — self-healing, no bulk migration.
//
// This module handles the crypto directly rather than delegating to
// lib/idEncryption.ts so token rotation is decoupled from the SA-ID
// key rotation schedule.

const PRIMARY_KEY_ENV = 'TOKEN_ENCRYPTION_KEY';
const LEGACY_KEY_ENV  = 'SA_ID_ENCRYPTION_KEY';

function readKey32(envVar: string): Buffer {
  const raw = process.env[envVar];
  if (!raw) {
    throw new Error(`${envVar} environment variable is not set`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(
      `${envVar} must decode to exactly 32 bytes (got ${key.byteLength}). ` +
      "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

function getPrimaryKey(): Buffer { return readKey32(PRIMARY_KEY_ENV); }

/** Legacy key — optional. Returns null if the env var is not set
 *  (fresh deployments never encrypted anything under the SA-ID key). */
function getLegacyKey(): Buffer | null {
  if (!process.env[LEGACY_KEY_ENV]) return null;
  try { return readKey32(LEGACY_KEY_ENV); } catch { return null; }
}

/** Encrypt a plaintext secret under TOKEN_ENCRYPTION_KEY. Always
 *  emits under the primary key — no legacy path on write. */
export function encryptToken(plaintext: string): string {
  const key = getPrimaryKey();
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export type DecryptResult = {
  plaintext:     string;
  usedLegacyKey: boolean;
};

/** Decrypt a value produced by encryptToken. Tries the primary key
 *  first; on GCM auth failure falls back to the legacy key. Logs a
 *  warning when the legacy path succeeds so operators see the
 *  self-heal happening.
 *
 *  Never returns '' on malformed input — throws so callers surface
 *  "reconnect Gmail" rather than silently attempting API calls with
 *  an empty string. */
export function decryptToken(stored: string): DecryptResult {
  if (!stored) throw new Error('decryptToken called on empty value');

  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid encrypted token format');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv        = Buffer.from(ivB64,  'base64');
  const tag       = Buffer.from(tagB64, 'base64');
  const ct        = Buffer.from(ctB64,  'base64');

  // Attempt 1: primary key
  try {
    const dec = createDecipheriv('aes-256-gcm', getPrimaryKey(), iv);
    dec.setAuthTag(tag);
    const plaintext = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
    return { plaintext, usedLegacyKey: false };
  } catch (primaryErr) {
    // Attempt 2: legacy key (if set)
    const legacy = getLegacyKey();
    if (legacy) {
      try {
        const dec = createDecipheriv('aes-256-gcm', legacy, iv);
        dec.setAuthTag(tag);
        const plaintext = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
        console.warn(
          '[tokenEncryption] decrypted under legacy SA_ID_ENCRYPTION_KEY — ' +
          'row will be re-encrypted under TOKEN_ENCRYPTION_KEY on next successful refresh',
        );
        return { plaintext, usedLegacyKey: true };
      } catch { /* fall through — throw the primary error */ }
    }
    throw primaryErr;
  }
}
