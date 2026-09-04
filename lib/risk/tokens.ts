// ─── Correlation tokens ─────────────────────────────────────────────────
//
// Nothing in risk_observations is a raw identifier. Every value in `token`
// is a keyed HMAC computed here, so the correlation store is a set of opaque
// equality keys: it can answer "are these two accounts the same device" and
// it cannot answer "what device is this".
//
// That is the whole privacy posture of the fraud controls, and it is what
// makes retaining a correlation graph for 90 days defensible under POPIA —
// the store holds no personal information that survives the key. See
// docs/FRAUD-RISK-OPERATIONS.md.
//
// ─── WHY RE-TOKENISE VALUES THAT ARE ALREADY HASHED ─────────────────────
//
// The SA ID blind index (0096) is ALREADY an HMAC, and it would have been
// less code to store it directly. It is re-tokenised under the risk key
// anyway, because storing it raw would make risk_observations joinable to
// profiles.sa_id_lookup_hash by anyone who obtained both. A correlation
// store that can be joined back to the identity table is a re-identification
// database, which is the exact thing this module exists not to build.
//
// The same argument applies to the card fingerprint, which is a synthetic
// brand:last4:expiry string (lib/payments/peach/saveCardForPatient.ts) —
// low-entropy enough to be recovered from a leaked column by dictionary
// attack if it were stored unkeyed.
//
// ─── NORMALISE, THEN HASH ───────────────────────────────────────────────
//
// A keyed hash is an equality test and nothing else, so two spellings of the
// same thing produce two tokens and the correlation silently fails. Every
// dimension therefore has an explicit normal form applied BEFORE hashing,
// and the normalisation is the part worth reviewing: an email compared
// case-sensitively, or a phone number compared with and without its country
// code, is a velocity rule that does not fire.

import { createHmac } from 'node:crypto';
import type { RiskDimension } from './vocabulary';

const KEY_ENV = 'RISK_CORRELATION_HMAC_KEY';

/**
 * Thrown when there is no key material at all.
 *
 * Deliberately an exception rather than a null token. A null token makes the
 * rules for that dimension SKIP (see 0142's rule loop), which would turn a
 * missing environment variable into "the fraud controls are off" with no
 * outward sign. evaluateRisk catches this and applies the event's
 * fail-closed posture, so a keyless deployment refuses the surface instead
 * of quietly running unprotected.
 */
export class RiskKeyUnavailableError extends Error {
  constructor() {
    super('no key material for risk correlation tokens');
    this.name = 'RiskKeyUnavailableError';
  }
}

function correlationKey(): string {
  // A dedicated key is preferred so the correlation store can be re-keyed
  // (which erases the graph — a legitimate privacy operation) without
  // touching database access. The service key is the fallback because every
  // call site already requires it to reach the RPC at all, so the fallback
  // never widens what a leak of one secret gives an attacker.
  const key = process.env[KEY_ENV] ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new RiskKeyUnavailableError();
  return key;
}

/**
 * Lowercase hex, truncated to 32 chars (128 bits) — collision-free at any
 * plausible volume, and half the storage of a full digest on a table that
 * gets one row per signal per request.
 *
 * The dimension is part of the pre-image so the same raw string in two
 * dimensions produces two tokens. Without that, a phone number used as a
 * password-reset subject and the same number in the phone dimension would
 * collide, and an email that happens to equal a device id would link two
 * unrelated subjects.
 */
function digest(dimension: RiskDimension, normalized: string): string {
  return createHmac('sha256', correlationKey())
    .update(`${dimension} ${normalized}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

// ─── Normal forms ───────────────────────────────────────────────────────

/**
 * Lowercased, trimmed. Nothing more: stripping dots or +tags from the local
 * part would merge addresses that Gmail merges and that other providers
 * genuinely do not, producing false links between strangers. The
 * `email_domain` dimension covers the disposable-mailbox case separately
 * and honestly.
 */
export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v.includes('@') && v.length > 2 ? v : null;
}

export function normalizeEmailDomain(raw: string): string | null {
  const email = normalizeEmail(raw);
  if (!email) return null;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return domain.length > 1 ? domain : null;
}

/**
 * Digits only, with South African local numbers folded to their country
 * code. `0821234567`, `+27821234567` and `0027821234567` are one person and
 * must be one token — a velocity rule that treats them as three numbers is
 * not a velocity rule.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D+/g, '');
  if (digits.length < 7) return null;
  if (digits.startsWith('0027')) return `27${digits.slice(4)}`;
  if (digits.startsWith('27'))   return digits;
  if (digits.startsWith('0'))    return `27${digits.slice(1)}`;
  return digits;
}

/** Strips an IPv6 zone id, brackets and a trailing port; lowercases. */
export function normalizeIp(raw: string): string | null {
  let v = raw.trim();
  if (!v) return null;
  if (v.startsWith('[')) {
    const close = v.indexOf(']');
    if (close > 0) v = v.slice(1, close);
  } else if (v.split(':').length === 2 && v.includes('.')) {
    // "1.2.3.4:5678" — a v4 address with a port. A bare v6 address also
    // contains colons, which is why this only fires when a dot is present.
    v = v.slice(0, v.indexOf(':'));
  }
  const zone = v.indexOf('%');
  if (zone > 0) v = v.slice(0, zone);
  v = v.toLowerCase();
  return v.length ? v : null;
}

/**
 * Bank account numbers are entered with spaces and dashes; strip them so a
 * payout destination is one token however it was typed.
 */
export function normalizeAccountNumber(raw: string): string | null {
  const cleaned = raw.replace(/[^0-9a-z]/gi, '').toLowerCase();
  return cleaned.length >= 4 ? cleaned : null;
}

const NORMALIZERS: Partial<Record<RiskDimension, (raw: string) => string | null>> = {
  email:        normalizeEmail,
  email_domain: normalizeEmailDomain,
  phone:        normalizePhone,
  ip:           normalizeIp,
  bank_account: normalizeAccountNumber,
};

/**
 * The one way a correlation token is produced.
 *
 * Returns null when the raw value is absent or does not normalise — an
 * unresolvable signal, which the decision function treats as "this rule does
 * not apply" rather than as a failure. Throws only when there is no key at
 * all; see RiskKeyUnavailableError.
 */
export function riskToken(
  dimension: RiskDimension,
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw);
  if (!value.trim()) return null;
  const normalize = NORMALIZERS[dimension] ?? ((v: string) => v.trim());
  const normalized = normalize(value);
  if (!normalized) return null;
  return digest(dimension, normalized);
}

/**
 * The customer-merchant edge as a single token.
 *
 * Hashed as a pair rather than stored as two ids, so the edge is one
 * countable thing and cannot be decomposed back into either endpoint from
 * the store alone. "This customer has taken five plans at this one practice
 * today" is a question about the edge, not about either side of it.
 */
export function customerMerchantToken(
  patientId: string | null | undefined,
  practiceId: string | null | undefined,
): string | null {
  if (!patientId || !practiceId) return null;
  return digest('customer_merchant', `${patientId} ${practiceId}`);
}

/**
 * Practice, group and provider ids pass through unhashed.
 *
 * Deliberate, and the one exception to the rule at the top of this file.
 * These are internal UUIDs already present in plain sight on plans, payouts
 * and bills; tokenising them would buy no privacy and would make the
 * merchant-side queries — "which practice is this" — unjoinable to the
 * tables a reviewer needs to open next.
 */
export function internalToken(id: string | null | undefined): string | null {
  const v = (id ?? '').trim();
  return v.length ? v : null;
}
