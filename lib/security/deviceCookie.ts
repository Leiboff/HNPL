// ─── The device correlation cookie ──────────────────────────────────────
//
// WHY THIS EXISTS
//
// 'device' is the highest-weight correlation key in identityGraph.ts, and
// without a stable per-browser value it is always null — which would make
// the strongest signal in the ring detector permanently absent. This is
// the value.
//
// WHAT IT IS: an opaque random 128-bit identifier, minted on first
// contact, meaning nothing on its own. It is not derived from anything
// about the browser or the person; it is a coin flip stored in a cookie.
//
// WHAT IT IS NOT: a fingerprint. There is deliberately no canvas hashing,
// no font enumeration, no WebGL probing, no audio-stack timing. Those
// techniques are more durable than a cookie, and rejected anyway:
//
//   • they identify a browser across sites and across clearing, which is
//     tracking, not fraud control — and for a HEALTHCARE product, a
//     durable cross-site identifier attached to people seeking medical
//     credit is a category of data we should not create;
//   • they are legally fraught under POPIA in a way a first-party,
//     purpose-limited, disclosed cookie is not;
//   • an attacker running a fresh browser profile per identity defeats
//     both, so the durability buys much less against the actual threat
//     than it costs everyone else.
//
// THE HONEST LIMITATION, stated plainly: an attacker who clears cookies
// between signups breaks this link. That is expected. The ring detector is
// built as a set of independent axes precisely because each one is
// individually evadable — an operator who clears cookies still shares a
// card, a network, and a tempo. Evading all of them at once is the cost
// this design imposes; no single key is asked to be unbeatable.
//
// httpOnly, so page scripts cannot read it. Nothing in the browser needs
// it — it is read server-side only — and a value no script can read is a
// value no XSS can exfiltrate and no third party can correlate on.

import { randomBytes } from 'crypto';

export const DEVICE_COOKIE = 'hnpl_did';

/**
 * Two years. Long enough that a returning household still correlates to
 * the device the family already used; short enough to be a defensible
 * retention answer. Note the ledger's own 180-day retention (migration
 * 0136) bounds what this can actually link to, so a longer cookie would
 * buy nothing.
 */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 730;

/** 128 bits of randomness, hex. Carries no information about the client. */
export function mintDeviceId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Is this a value we minted?
 *
 * The cookie is client-supplied, so an attacker can send anything — and
 * anything is exactly what must not reach the ledger. Two failure modes
 * this closes:
 *
 *   • a caller sending ONE shared constant across many signups would
 *     manufacture a false ring implicating every real patient who happened
 *     to be assigned it — the ledger is keyed on the hash of this value,
 *     so a chosen value is a chosen key;
 *   • an unbounded string is unbounded storage.
 *
 * Shape-checking does not stop an attacker CHOOSING a well-formed value —
 * nothing can, short of signing it — but it keeps malformed and oversized
 * input out of the ledger, and it means a value in the table is one that
 * at least could have come from us. Reused-value abuse is caught
 * downstream instead: a chosen constant shared across many identities is,
 * to identityGraph, simply a device with an implausible number of people
 * on it.
 */
export function isWellFormedDeviceId(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
