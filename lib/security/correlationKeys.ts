// ─── Correlation keys: seeing a ring without storing who is in it ───────
//
// THE GAP THIS FILLS
//
// Every identity control in this system judges ONE applicant in isolation.
// The DHA/Datanamix registry query, the liveness check, the face match,
// the 18+ gate, the one-SA-ID-one-account blind index, the per-profile
// credit limit — each is strong, and each answers only "is this person
// who they say they are, and may THEY borrow?".
//
// That is the wrong question for the attack that actually scales. The
// dominant synthetic/farmed-identity pattern is a RING: forty applicants
// who are each individually verifiable — because forty real ID documents
// and forty real faces were rented for R500 apiece — funnelled through one
// device, one network, one card, or one colluding practice. Every one of
// them passes every check we have. Nothing in the system has ever been
// able to see that they arrived together.
//
// Correlation needs a key that is the SAME for two sessions that share a
// device or a network, and that is why this module exists.
//
// WHY THE KEYS ARE HMACs AND NOT THE VALUES THEMSELVES
//
// The naive version of this table stores raw IPs, raw User-Agents and raw
// phone numbers next to a user id, and is a surveillance database — a
// standing POPIA liability, and a far more attractive breach target than
// the thing it protects. We do not need to KNOW the IP. We only need to
// know that two rows share one.
//
// So every key here is an HMAC-SHA256 under a dedicated secret, exactly
// the construction lib/idEncryption.ts already uses for the SA ID blind
// index (hashIdForLookup). The properties that matter:
//
//   • deterministic — two sessions from one device collide, which is the
//     entire point;
//   • one-way — a stolen ledger yields no IPs, no numbers, no devices;
//   • key-separated — a per-kind domain tag means a device hash can never
//     collide with an IP hash, so a match always means what it says;
//   • unrentable — without CORRELATION_HMAC_KEY, an attacker who guesses
//     an IP cannot confirm the guess by recomputing the hash. A bare
//     SHA-256 of an IPv4 address is brute-forceable in seconds; the whole
//     v4 space is 2^32. The secret is what makes this a blind index
//     rather than a lookup table.
//
// FAIL CLOSED ON A MISSING KEY, AT THE CALLER
//
// These functions throw when the key is absent, matching readKey in
// lib/idEncryption.ts. They are called from the signal recorder, which
// catches — recording is best-effort and must never cost a real customer
// their signup. What must NOT happen is a silent downgrade to an
// unkeyed hash: that would quietly turn the ledger into the
// brute-forceable thing described above. Absent key, absent signal.

import { createHmac } from 'crypto';
import { normalizePhoneZA } from '@/lib/validation/phone';

const KEY_ENV = 'CORRELATION_HMAC_KEY';

/**
 * The kinds of thing we correlate on. The tag is mixed into the HMAC so
 * the same underlying string in two roles produces two unrelated keys.
 *
 * Adding a kind here is a deliberate act: each one widens what the ledger
 * can see, and each needs its own justification in identityGraph.ts for
 * why sharing it is evidence of anything.
 */
export type CorrelationKind =
  /** A first-party device cookie — durable, and cheap for an attacker to clear. */
  | 'device'
  /** The full client IP. Precise, and a VPN hop away from useless. */
  | 'ip'
  /** The IPv4 /24 or IPv6 /48. Survives the hop within one network. */
  | 'subnet'
  /** Alias-normalised email — defeats gmail dots and +tags. */
  | 'email'
  /** E.164 phone. */
  | 'phone'
  /** The payment provider's own card fingerprint (already a token, hashed again for uniformity). */
  | 'card';

function readKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(
      `${KEY_ENV} environment variable is not set. ` +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(`${KEY_ENV} must decode to exactly 32 bytes (got ${key.byteLength}).`);
  }
  return key;
}

/**
 * The one hashing primitive. Domain-tagged so a device hash and an IP
 * hash of the same string are different values.
 *
 * Returns null for a blank input rather than hashing the empty string —
 * a hash of "" is a real, colliding value, and every applicant who
 * happened to be missing a signal would link to every other one. An
 * absent signal must produce an absent key, never a shared one.
 */
export function correlationKey(kind: CorrelationKind, value: string | null | undefined): string | null {
  const normalized = normalizeForKind(kind, value);
  if (normalized === null) return null;
  return createHmac('sha256', readKey())
    .update(`hnpl/correlation/v1/${kind}:`, 'utf8')
    .update(normalized, 'utf8')
    .digest('hex');
}

// ─── Normalisation ──────────────────────────────────────────────────────
//
// Every kind is normalised BEFORE hashing, because an HMAC has no notion
// of "nearly the same". If "Bob@Gmail.com" and "bob@gmail.com" hash
// differently, the alias check is decorative.

function normalizeForKind(kind: CorrelationKind, value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0) return null;

  switch (kind) {
    case 'email':  return normalizeEmailAlias(raw);
    // Landlines allowed here though the signup validator rejects them:
    // a shared practice landline across twelve 'unrelated' applicants is
    // exactly the correlation this ledger exists to see, and refusing to
    // key it would blind us to the collusion case specifically.
    case 'phone':  return normalizePhoneZA(raw, { allowLandline: true }) ?? null;
    case 'ip':     return normalizeIp(raw);
    case 'subnet': return ipSubnet(raw);
    case 'device':
    case 'card':
      return raw.toLowerCase();
  }
}

/**
 * Alias-normalised email.
 *
 * Three tricks give one mailbox unlimited distinct-looking addresses, and
 * all three are standard kit in account-farming:
 *
 *   bob+1@gmail.com   → subaddressing (+tag). Supported by Gmail, Outlook,
 *                        Fastmail, Proton and most modern hosts.
 *   b.o.b@gmail.com   → Gmail ignores dots in the local part entirely.
 *   BOB@GMAIL.COM     → case.
 *
 * We strip all three. Note the deliberate asymmetry: +tags are stripped
 * for EVERY host (near-universal now, and a host that treats +tags as
 * distinct mailboxes is rare enough that over-linking there is the safer
 * error), but dots ONLY for the Google-operated domains where that is
 * actually the rule. Stripping dots universally would link
 * john.smith@company.com to johnsmith@company.com — two different
 * colleagues at most corporate hosts, and a false ring is not a free
 * mistake: it can freeze a real patient out of credit.
 *
 * THIS IS A LINKING KEY, NOT A LOGIN KEY. It exists to notice that eight
 * "different" applicants share a mailbox. It must never be used to
 * resolve an account for authentication — the address the user typed is
 * the one that owns the session.
 */
export function normalizeEmailAlias(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;

  let local  = email.slice(0, at).toLowerCase();
  const host = email.slice(at + 1).toLowerCase();

  const plus = local.indexOf('+');
  if (plus === 0) return null;            // "+tag@host" has no mailbox left
  if (plus > 0) local = local.slice(0, plus);

  if (GOOGLE_MAIL_HOSTS.has(host)) local = local.replace(/\./g, '');

  if (local.length === 0) return null;
  return `${local}@${host}`;
}

/** Domains where Gmail's dot-insensitivity actually applies. */
const GOOGLE_MAIL_HOSTS = new Set(['gmail.com', 'googlemail.com']);

/** Lowercased, with an IPv4-mapped IPv6 prefix (::ffff:) unwrapped. */
function normalizeIp(raw: string): string | null {
  const ip = raw.toLowerCase().replace(/^::ffff:/, '');
  if (ip.length === 0) return null;
  return ip;
}

/**
 * The network an address sits in: IPv4 /24, IPv6 /48.
 *
 * Correlating on the exact IP alone is weak — a mobile network reassigns
 * addresses constantly, so a ring on one handset can present a fresh IP
 * per signup without trying. The /24 (and the /48, which is the block a
 * residential IPv6 customer is typically delegated) is the unit an
 * attacker has to actually leave.
 *
 * It is also, for the same reason, the NOISIEST key here: a corporate
 * office, a university, a hospital waiting room on one guest network, or a
 * carrier-grade NAT can legitimately put hundreds of unrelated patients in
 * one /24. identityGraph.ts weights it accordingly — a subnet match alone
 * is never allowed to be sufficient evidence of anything.
 */
export function ipSubnet(raw: string): string | null {
  const ip = normalizeIp(raw);
  if (!ip) return null;

  if (ip.includes(':')) {
    // IPv6 → first three hextets (/48). Handles "::" by rejecting only
    // when there is nothing to take.
    const groups = ip.split(':').filter((g) => g.length > 0);
    if (groups.length === 0) return null;
    return `${groups.slice(0, 3).join(':')}::/48`;
  }

  const octets = ip.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) {
    return null;
  }
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}
