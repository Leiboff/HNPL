// ─── Token encryption wrapper ────────────────────────────────────────
//
// Reuses the AES-256-GCM helper from lib/idEncryption.ts under a name
// that reads intent — this module encrypts arbitrary secrets (OAuth
// refresh tokens today; other credentials in future) rather than SA
// IDs. Same key (SA_ID_ENCRYPTION_KEY), same ciphertext format
// (v1:iv:tag:ct), so a rotation is a single-key rotation.
//
// Server-only. Never import from a 'use client' file — the underlying
// module reads `SA_ID_ENCRYPTION_KEY` from process.env, which is
// undefined in the browser and would throw on first call.

import { encryptId, decryptId } from '@/lib/idEncryption';

/** Encrypt a plaintext secret (e.g. a Gmail refresh token). */
export function encryptToken(plaintext: string): string {
  return encryptId(plaintext);
}

/** Decrypt a token produced by encryptToken. Never returns '' on
 *  malformed input — throws (a corrupt refresh token must fail loud
 *  so we prompt the operator to reconnect Gmail rather than silently
 *  attempting API calls with an empty string). */
export function decryptToken(stored: string): string {
  if (!stored) throw new Error('decryptToken called on empty value');
  return decryptId(stored);
}
