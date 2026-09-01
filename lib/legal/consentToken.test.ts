// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  issueConsentToken,
  verifyConsentToken,
  TERMS_CONSENT_COOKIE,
  TERMS_CONSENT_TTL_SECONDS,
} from './consentToken';
import { TERMS_VERSION } from './terms';
import { PRIVACY_VERSION } from './privacy';
import { TERMS_DOC_SHA256, PRIVACY_DOC_SHA256 } from './documentHash';

// ─── The acceptance the server can vouch for (audit A-14) ─────────────────
//
// /auth/callback recorded the legal acceptance on the strength of
// `?terms_accepted=1`. The refusal direction was well defended and still is;
// the ASSERTION direction was not, so appending that parameter recorded an
// agreement to a document that had never been rendered.
//
// Nobody attacks it — the person doing it is the person whose consent it is,
// and they gain a session they were going to get by ticking a box. The
// exposure runs the other way: the record was not EVIDENCE. In a dispute over
// an NCA credit agreement, or over POPIA §11 consent to process special
// personal information, a customer could point out that the flag came from a
// parameter they controlled, and the platform could not show the documents
// were ever displayed.
//
// So the tests below are about EVIDENCE rather than about access control, and
// they are arranged around the three things the record now has to survive:
//
//   forgery   a token nobody signed, or signed with the wrong key
//   replay    a token from a month ago, or from a previous version of the text
//   drift     a token minted against terms 1.0 recording an acceptance of 1.1

const ORIGINAL_ENV = { ...process.env };

const b64url = (b: Buffer) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Build a CORRECTLY SIGNED token with one field of our choosing changed.
 *
 * The point of the drift tests is that a token can be perfectly authentic and
 * still be refused, so they must not accidentally test the signature check
 * instead. This signs whatever it is given.
 */
function forge(overrides: Record<string, unknown>): string {
  const body = b64url(Buffer.from(JSON.stringify({
    v:   'v1',
    exp: Math.floor(Date.now() / 1000) + 600,
    n:   'nonce123',
    tv:  TERMS_VERSION,
    pv:  PRIVACY_VERSION,
    td:  TERMS_DOC_SHA256,
    pd:  PRIVACY_DOC_SHA256,
    ...overrides,
  }), 'utf8'));
  const sig = b64url(
    crypto.createHmac('sha256', process.env.TERMS_CONSENT_SECRET!).update(body).digest(),
  );
  return `${body}.${sig}`;
}

beforeEach(() => {
  process.env.TERMS_CONSENT_SECRET = 'test-secret-not-a-real-one';
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('a token the server issued verifies', () => {
  it('round-trips, carrying what was on screen', () => {
    const { token } = issueConsentToken();
    const v = verifyConsentToken(token);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // Not just "they accepted" — "they accepted THESE documents". The digest
    // is what makes the row answer "which text" without trusting that nobody
    // edited a clause.
    expect(v.termsVersion).toBe(TERMS_VERSION);
    expect(v.privacyVersion).toBe(PRIVACY_VERSION);
    expect(v.termsDocSha256).toBe(TERMS_DOC_SHA256);
    expect(v.privacyDocSha256).toBe(PRIVACY_DOC_SHA256);
  });

  it('lives for 30 minutes — long enough to read, short enough not to be standing', () => {
    expect(TERMS_CONSENT_TTL_SECONDS).toBe(30 * 60);
    const now = new Date('2026-09-02T10:00:00Z');
    const { token, maxAgeSeconds } = issueConsentToken(now);
    expect(maxAgeSeconds).toBe(TERMS_CONSENT_TTL_SECONDS);
    expect(verifyConsentToken(token, new Date('2026-09-02T10:29:00Z')).ok).toBe(true);
  });

  it('two tokens are never identical', () => {
    // A nonce, so a token is not a stable value that could be copied out of
    // one browser and pasted into another indefinitely.
    const a = issueConsentToken().token;
    const b = issueConsentToken().token;
    expect(a).not.toBe(b);
  });
});

describe('forgery', () => {
  it('refuses an absent token — the whole defect in one line', () => {
    // `?terms_accepted=1` with nothing behind it.
    const v = verifyConsentToken(null);
    expect(v).toEqual({ ok: false, reason: 'absent' });
    expect(verifyConsentToken('')).toEqual({ ok: false, reason: 'absent' });
  });

  it('refuses a token a visitor made up', () => {
    for (const junk of [
      'not-a-token',
      'v1',
      'eyJhIjoxfQ.deadbeef',
      '.',
      '.sig',
    ]) {
      expect(verifyConsentToken(junk).ok).toBe(false);
    }
  });

  it('refuses a token whose payload was edited after signing', () => {
    // Push the expiry out by a year, keep the original signature.
    const { token } = issueConsentToken();
    const [body, sig] = token.split('.');
    const p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    p.exp += 31_536_000;
    const edited = b64url(Buffer.from(JSON.stringify(p), 'utf8'));
    expect(verifyConsentToken(`${edited}.${sig}`)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a payload that is not the JSON it should be', () => {
    // Signed, so the signature check passes — the decode is what refuses. The
    // ordering matters: the signature is verified BEFORE anything parses the
    // bytes, so no unauthenticated input ever reaches JSON.parse.
    const body = b64url(Buffer.from('not json at all', 'utf8'));
    const sig  = b64url(
      crypto.createHmac('sha256', process.env.TERMS_CONSENT_SECRET!).update(body).digest(),
    );
    expect(verifyConsentToken(`${body}.${sig}`)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('a version string containing the delimiter cannot move a field boundary', () => {
    // TERMS_VERSION is '1.0'. A dot-delimited payload would have let the
    // version carry the delimiter — which broke every token outright, and
    // would have been a signature-scope hole if a field were ever
    // attacker-influenced. The payload is base64url'd JSON, so the token has
    // exactly one delimiter and it cannot occur inside the encoding.
    expect(TERMS_VERSION).toContain('.');
    const { token } = issueConsentToken();
    expect(token.split('.')).toHaveLength(2);
    expect(verifyConsentToken(token).ok).toBe(true);
  });

  it('refuses a token signed with a different key', () => {
    const { token } = issueConsentToken();
    process.env.TERMS_CONSENT_SECRET = 'a-different-secret';
    expect(verifyConsentToken(token)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('does not throw on a signature of the wrong LENGTH', () => {
    // timingSafeEqual throws on mismatched buffer lengths, so a one-character
    // signature would turn a forgery into a 500 rather than a refusal.
    const { token } = issueConsentToken();
    const short = `${token.split('.')[0]}.x`;
    expect(() => verifyConsentToken(short)).not.toThrow();
    expect(verifyConsentToken(short)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('replay and drift', () => {
  it('refuses an expired token', () => {
    const { token } = issueConsentToken(new Date('2026-09-02T10:00:00Z'));
    expect(verifyConsentToken(token, new Date('2026-09-02T10:31:00Z')))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a token minted against a DIFFERENT version of the documents', () => {
    // The drift case, and the reason it is a refusal rather than a pass: a
    // visitor with /signup open when terms 1.1 is published must not have
    // their acceptance recorded as an acceptance of 1.1. The version they saw
    // is the version they agreed to; if it has moved they see the new one.
    // Signed PROPERLY, so the only thing wrong with it is the version — a
    // wrongly-signed token would fail earlier and prove nothing about drift.
    expect(verifyConsentToken(forge({ tv: '0.9' })))
      .toEqual({ ok: false, reason: 'stale_document' });
  });

  it('refuses a token whose document digest no longer matches', () => {
    // The same refusal via the other half of the pair: the version string was
    // not bumped but the text changed, which is exactly the situation the
    // digest exists to make visible.
    expect(verifyConsentToken(forge({ td: 'f'.repeat(64) })))
      .toEqual({ ok: false, reason: 'stale_document' });
  });
});

describe('the signing key', () => {
  it('falls back to a DERIVED key rather than throwing when the env var is unset', () => {
    // hashOtpCode throws when its pepper is missing, and is right to: that
    // path fails visibly and locally. This one cannot afford to — a deploy
    // that forgot one env var would bounce every Google signup into the terms
    // refusal, in a loop, and only in production. So it derives from the
    // service-role key, which the application provably has.
    delete process.env.TERMS_CONSENT_SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-for-test';
    const { token } = issueConsentToken();
    expect(verifyConsentToken(token).ok).toBe(true);
  });

  it('the derived key is not the service key itself', () => {
    // It appears in Authorization headers. A token signed with it directly
    // would be signed with a credential that travels, so the derivation is
    // domain-separated and one-way.
    delete process.env.TERMS_CONSENT_SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-for-test';
    const { token } = issueConsentToken();

    const [body, sig] = token.split('.');
    const naive = b64url(
      crypto.createHmac('sha256', 'service-role-key-for-test').update(body).digest(),
    );
    expect(sig).not.toBe(naive);
  });

  it('an explicit secret takes precedence, so the key can be rotated alone', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-for-test';
    process.env.TERMS_CONSENT_SECRET = 'rotated';
    const { token } = issueConsentToken();
    delete process.env.TERMS_CONSENT_SECRET;
    // Now verifying with the derived key: the same token must NOT verify.
    expect(verifyConsentToken(token).ok).toBe(false);
  });
});

describe('the cookie name is shared, not restated', () => {
  it('one constant, used by the minter and the reader', () => {
    expect(TERMS_CONSENT_COOKIE).toBe('hnpl_terms_consent');
  });
});
