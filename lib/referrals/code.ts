// ─── Referral codes: the alphabet, the shape, and how one is minted ───────
//
// A referral code is a SHAREABLE SECRET-ISH STRING. It is read off a screen
// and typed into another phone, spoken over a call, and pasted into a
// WhatsApp message. Every property below follows from that and from nothing
// else.
//
// ─── WHY NOT A UUID ──────────────────────────────────────────────────────
//
// The obvious cheap answer is `gen_random_uuid()`. It is unguessable, it is
// already used for every primary key here, and it is unusable for this: 36
// characters with hyphens, mixed case, and full of the exact glyph pairs a
// person cannot tell apart when reading them aloud. A code nobody can dictate
// is a code that only works through the share link, which throws away half of
// what a referral programme is.
//
// ─── THE ALPHABET ────────────────────────────────────────────────────────
//
// Crockford's set: the 36 alphanumerics minus I, L, O, U, 0 and 1.
//
//   I/1/L  and  O/0  are the two pairs that get mistyped, in every font
//                    a phone might render this in.
//   U      is dropped for the reason Crockford drops it — it keeps the
//          accidental-obscenity surface down, which matters for a string
//          the platform prints and a customer forwards to a friend.
//
// Upper case only, so "was that a lower-case l or a one" never arises, and
// so the normalisation on the way back in is a single toUpperCase().
//
// ─── THE LENGTH ──────────────────────────────────────────────────────────
//
// Eight characters over a 30-character alphabet is ~39 bits — about 6.6e11
// codes. That is not a password and is not treated as one: what a guessed
// code buys an attacker is an ATTRIBUTION, not access to anything. The
// consequence of a collision is worse than the consequence of a guess, which
// is why the uniqueness constraint lives in the database (0145) rather than
// in a birthday-paradox argument here.
//
// Eight is also the length a person will actually read out. Twelve would be
// more bits and fewer completed referrals.
//
// ─── WHERE THIS IS MIRRORED ──────────────────────────────────────────────
//
// `referral_codes.code` carries a CHECK constraint with this same character
// class. Two definitions is a drift risk, accepted for the same reason
// migration 0134 accepts it for rate-limit buckets: the database cannot
// check a code against the application by reading it. lib/referrals/
// code.test.ts pins the two against each other, so a change on one side
// fails the suite rather than silently admitting a code the other side
// refuses.

import { randomInt } from 'node:crypto';

/** Crockford's base-32 set. See the header for why each exclusion is there. */
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export const REFERRAL_CODE_LENGTH = 8;

/** The one regular expression. The SQL CHECK in 0145 is its twin. */
export const REFERRAL_CODE_PATTERN =
  new RegExp(`^[${REFERRAL_CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`);

/**
 * Mint a code.
 *
 * `randomInt` from node:crypto, NOT `Math.random()`. Not because a guessed
 * code is catastrophic — see the header — but because a predictable one lets
 * anyone enumerate every customer's code from one sample, and the CSPRNG
 * costs nothing here. `randomInt(max)` is also rejection-sampled inside Node,
 * so there is no modulo bias to reason about.
 */
export function generateReferralCode(): string {
  let out = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    out += REFERRAL_CODE_ALPHABET[randomInt(REFERRAL_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * What a human typed → what we look up, or null if it cannot be a code.
 *
 * Returns null rather than a best-effort string: a lookup on a mangled value
 * is a lookup that finds nothing, and "no such code" is a much worse message
 * than "that doesn't look like a code" when the real problem is a typo.
 *
 * The three transformations, each for an observed input shape:
 *
 *   trim            — a paste from WhatsApp brings whitespace with it.
 *   toUpperCase     — the keyboard on a phone starts lower case.
 *   strip - and ␠   — people group characters when they write a code down
 *                     ("A2C4-K9PT"), and a dash is not information.
 *
 * Deliberately NOT done: mapping O→0, I→1, L→1. Those characters are not in
 * the alphabet, so a code containing one is a typo, and silently "correcting"
 * it would resolve to a DIFFERENT valid code belonging to someone else.
 */
export function normaliseReferralCode(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().toUpperCase().replace(/[\s-]/g, '');
  return REFERRAL_CODE_PATTERN.test(cleaned) ? cleaned : null;
}

/** Cheap predicate for call sites that only need the yes/no. */
export function isWellFormedReferralCode(input: string | null | undefined): boolean {
  return normaliseReferralCode(input) !== null;
}
