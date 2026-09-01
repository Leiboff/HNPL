import crypto from 'crypto';
import { TERMS_VERSION } from './terms';
import { PRIVACY_VERSION } from './privacy';
import { TERMS_DOC_SHA256, PRIVACY_DOC_SHA256 } from './documentHash';

// ─── An acceptance the server can vouch for ────────────────────────────────
//
// THE DEFECT (audit 2026-09-02, A-14)
//
// The OAuth callback recorded the legal acceptance — terms_accepted_at,
// terms_version, privacy_version — on the strength of a query parameter:
//
//     const consentGiven = url.searchParams.get('terms_accepted') === '1';
//
// The refusal direction was well defended and still is: a visitor who does
// not tick the box is bounced, and adversarial tests hold that closed. The
// ASSERTION direction was unguarded. Appending `&terms_accepted=1` to the
// callback recorded an agreement to a document that was never rendered.
//
// Nobody attacks this — the person doing it is the person whose consent it
// is, and they gain a session they were going to get anyway by ticking a box.
// The exposure runs the other way: THE RECORD IS NOT EVIDENCE. A customer
// disputing an NCA credit agreement can point out that the flag was set by a
// parameter they controlled, and the platform cannot show the terms were ever
// displayed. For a credit product, and for POPIA §11 consent to process
// special personal information, that is the whole value of the column.
//
// ─── WHAT THIS IS ──────────────────────────────────────────────────────────
//
// A short-lived HMAC-signed token, issued by the SERVER at the moment it
// renders the acceptance control, carried in an httpOnly cookie, and required
// by the callback. The record then attests to something the server did rather
// than to something the browser claimed.
//
// It also carries what was on screen: both version strings and both document
// digests, signed. So the stored row is not just "they accepted" — it is
// "they accepted terms 1.0 with digest 06938e…, and the server had rendered
// exactly that".
//
// ─── WHY A COOKIE AND NOT THE QUERY STRING ─────────────────────────────────
//
// The OAuth round trip leaves the origin and comes back to /auth/callback, so
// whatever carries this has to survive a cross-site redirect. A signed token
// in the URL would survive too, and would also be visible in Google's
// referrer chain, in browser history, and in any log that records query
// strings — a replayable consent assertion sitting in three places it does
// not need to be.
//
// httpOnly + SameSite=Lax is the right pair: Lax is delivered on a top-level
// GET navigation, which is exactly what the OAuth return is, and withheld
// from the cross-site POSTs that make CSRF interesting. httpOnly keeps it out
// of reach of any script on the page.
//
// ─── THE KEY, AND WHY IT FAILS THE WAY IT DOES ─────────────────────────────
//
// TERMS_CONSENT_SECRET if set. Otherwise a key DERIVED from the service-role
// key, which the application provably has (nothing works without it), with a
// fixed info string so it is domain-separated and the service key itself is
// never recoverable from a token.
//
// The alternative — throw when TERMS_CONSENT_SECRET is unset, as
// hashOtpCode does for its pepper — would mean a deploy that forgot one env
// var bounces every Google signup into the terms refusal, in a loop, and only
// in production. The pepper can afford to be strict because the OTP path
// fails visibly and locally; this one cannot.
//
// Verification still fails CLOSED in every other case: a missing, expired,
// malformed or wrongly-signed token means no acceptance, which means
// 'needs-terms', which means no session.

const COOKIE_NAME = 'hnpl_terms_consent';

/** Long enough to read the documents, short enough not to be a standing claim. */
const TTL_SECONDS = 30 * 60;

const TOKEN_VERSION = 'v1';

export { COOKIE_NAME as TERMS_CONSENT_COOKIE, TTL_SECONDS as TERMS_CONSENT_TTL_SECONDS };

function signingKey(): Buffer {
  const explicit = process.env.TERMS_CONSENT_SECRET;
  if (explicit) return Buffer.from(explicit, 'utf8');

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    // Genuinely impossible in a running app — every server path here uses the
    // service client — so this is a programming error, not a config one.
    throw new Error('consentToken: neither TERMS_CONSENT_SECRET nor SUPABASE_SERVICE_ROLE_KEY is set');
  }
  // Domain-separated derivation. The service key is not usable as a signing
  // key directly: it appears in Authorization headers, and a token signed
  // with it would be signed with a credential that travels.
  return crypto.createHmac('sha256', serviceKey).update('hnpl/terms-consent/v1').digest();
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── The payload is base64url'd JSON, not a delimited string ───────────────
//
// The first cut of this joined the fields with dots. TERMS_VERSION is '1.0',
// so the version string carried the delimiter and every token parsed into the
// wrong number of fields.
//
// That is not just a bug to patch — a delimiter that can appear inside a
// field is a signature-scope problem. With `a.b` and `c` joined by a dot,
// `a` + `b.c` signs to the same bytes, so an attacker who controls one field
// can move a boundary without changing the signature. The version strings are
// ours rather than an attacker's today, and the encoding should not depend on
// that staying true.
//
// So: one JSON object, base64url-encoded, signed as a whole. There is exactly
// one delimiter in the token and it cannot occur inside the encoding.
type ConsentPayload = {
  v:   typeof TOKEN_VERSION;
  exp: number;
  n:   string;
  tv:  string;
  pv:  string;
  td:  string;
  pd:  string;
};

function encodePayload(p: ConsentPayload): string {
  return b64url(Buffer.from(JSON.stringify(p), 'utf8'));
}

function decodePayload(encoded: string): ConsentPayload | null {
  try {
    const json = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      .toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<ConsentPayload>;
    if (
      p.v !== TOKEN_VERSION
      || typeof p.exp !== 'number'
      || typeof p.n   !== 'string'
      || typeof p.tv  !== 'string'
      || typeof p.pv  !== 'string'
      || typeof p.td  !== 'string'
      || typeof p.pd  !== 'string'
    ) return null;
    return p as ConsentPayload;
  } catch {
    return null;
  }
}

function sign(body: string): string {
  return b64url(crypto.createHmac('sha256', signingKey()).update(body).digest());
}

export type IssuedConsentToken = {
  token: string;
  /** For the cookie's Max-Age. */
  maxAgeSeconds: number;
};

/**
 * Mint a token asserting that THIS server rendered the current terms and
 * privacy documents to somebody, just now.
 *
 * Call it from the code path that renders the acceptance control. It says
 * nothing about who: the callback pairs it with an authenticated session, and
 * the token's only job is to prove the documents were served.
 */
export function issueConsentToken(now: Date = new Date()): IssuedConsentToken {
  const body = encodePayload({
    v:   TOKEN_VERSION,
    exp: Math.floor(now.getTime() / 1000) + TTL_SECONDS,
    n:   b64url(crypto.randomBytes(12)),
    tv:  TERMS_VERSION,
    pv:  PRIVACY_VERSION,
    td:  TERMS_DOC_SHA256,
    pd:  PRIVACY_DOC_SHA256,
  });
  return { token: `${body}.${sign(body)}`, maxAgeSeconds: TTL_SECONDS };
}

export type VerifiedConsent = {
  ok: true;
  termsVersion:   string;
  privacyVersion: string;
  termsDocSha256: string;
  privacyDocSha256: string;
  expiresAt: Date;
};

export type ConsentFailure = {
  ok: false;
  reason: 'absent' | 'malformed' | 'bad_signature' | 'expired' | 'stale_document';
};

/**
 * Verify a token from the cookie. Fails closed on everything.
 *
 * `stale_document` is its own reason rather than a pass: a token minted
 * against terms 1.0 must not record an acceptance of 1.1 published while the
 * visitor had the page open. The version they saw is the version they agreed
 * to, and if it has moved they see the new one and tick again.
 */
export function verifyConsentToken(
  token: string | null | undefined,
  now: Date = new Date(),
): VerifiedConsent | ConsentFailure {
  if (!token) return { ok: false, reason: 'absent' };

  const cut = token.lastIndexOf('.');
  if (cut <= 0) return { ok: false, reason: 'malformed' };

  const body = token.slice(0, cut);
  const got  = token.slice(cut + 1);
  const want = sign(body);

  // Constant-time, and length-guarded so a short forgery cannot make
  // timingSafeEqual throw instead of returning false. The signature is
  // checked BEFORE the payload is decoded, so nothing downstream ever parses
  // bytes we have not authenticated.
  const gotBuf  = Buffer.from(got,  'utf8');
  const wantBuf = Buffer.from(want, 'utf8');
  if (gotBuf.length !== wantBuf.length || !crypto.timingSafeEqual(gotBuf, wantBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const p = decodePayload(body);
  if (!p) return { ok: false, reason: 'malformed' };
  if (p.exp * 1000 <= now.getTime()) return { ok: false, reason: 'expired' };

  if (
    p.tv !== TERMS_VERSION
    || p.pv !== PRIVACY_VERSION
    || p.td !== TERMS_DOC_SHA256
    || p.pd !== PRIVACY_DOC_SHA256
  ) {
    return { ok: false, reason: 'stale_document' };
  }

  return {
    ok: true,
    termsVersion:     p.tv,
    privacyVersion:   p.pv,
    termsDocSha256:   p.td,
    privacyDocSha256: p.pd,
    expiresAt: new Date(p.exp * 1000),
  };
}
