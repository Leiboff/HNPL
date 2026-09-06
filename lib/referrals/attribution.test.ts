import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REFERRAL_COOKIE,
  REFERRAL_COOKIE_MAX_AGE_SECONDS,
  referralCookieOptions,
} from './attribution';
import { REFERRAL_INVITE_TTL_DAYS } from './vocabulary';

describe('the referral cookie has the same posture as the invitation cookie', () => {
  // Not "similar" — the SAME. app/cookie-posture.test.ts pins the invitation
  // cookie's flags for reasons that apply identically here, and a second
  // scheme would mean a second set of reasons for somebody to get wrong.
  it('is httpOnly, lax, path-/ and thirty days', () => {
    const opts = referralCookieOptions(true);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(60 * 60 * 24 * REFERRAL_INVITE_TTL_DAYS);
    expect(REFERRAL_COOKIE_MAX_AGE_SECONDS).toBe(opts.maxAge);
  });

  it('is secure in production and not in development', () => {
    // The flag hardest to observe from inside a test environment, which is
    // exactly why isProduction is a parameter rather than a read of
    // process.env.
    expect(referralCookieOptions(true).secure).toBe(true);
    expect(referralCookieOptions(false).secure).toBe(false);
  });

  it('is namespaced like every other first-party cookie here', () => {
    expect(REFERRAL_COOKIE).toBe('hnpl_referral');
    expect(REFERRAL_COOKIE.startsWith('hnpl_')).toBe(true);
  });

  it('sameSite is lax and NOT strict, and the proxy relies on that', () => {
    // 'strict' drops the cookie on the top-level GET from WhatsApp, a mail
    // client or an SMS — which is the only arrival this cookie exists for.
    expect(referralCookieOptions(true).sameSite).not.toBe('strict');
  });
});

describe('the proxy uses these constants rather than its own literals', () => {
  const PROXY = readFileSync(resolve(process.cwd(), 'proxy.ts'), 'utf8');

  it('imports the cookie name instead of spelling it', () => {
    expect(PROXY).toContain('REFERRAL_COOKIE');
    // A literal would drift the day the name changes here, and the failure
    // would be invisible: a cookie nobody reads is a referral nobody gets.
    expect(PROXY).not.toMatch(/'hnpl_referral'/);
  });

  it('builds the cookie from referralCookieOptions', () => {
    expect(PROXY).toContain('referralCookieOptions');
  });

  it('only captures a code on a document navigation', () => {
    // Otherwise any page on the internet could write this cookie with a
    // chosen code — `<img src="https://app…/?ref=THEIRCODE">` is a GET to our
    // origin, and a referral cookie set from one is an attribution stolen
    // from whoever the visitor was actually referred by.
    expect(PROXY).toMatch(/isDocumentNavigation\s*\n?\s*\?\s*readReferralParam/);
  });

  it('does not overwrite a code it is already holding', () => {
    // First code wins, which is the same rule the write-once attribution
    // index enforces in the database (0145). The two layers have to agree:
    // a cookie that overwrote itself would send a second referrer's code to a
    // claim that then refuses it as already_attributed, and nobody would be
    // credited at all.
    expect(PROXY).toContain('referralParam && !heldReferral');
  });

  it('drops the cookie only on a terminal outcome', () => {
    // A database blip must not spend the cookie — it is the only copy of the
    // attribution, and claimReferral reports `terminal` separately from the
    // outcome precisely so this branch can exist.
    expect(PROXY).toMatch(/if \(claim\.terminal\) response\.cookies\.delete/);
  });

  it('only claims attribution for a patient profile', () => {
    expect(PROXY).toMatch(/claimant\?\.role !== 'patient'/);
    expect(PROXY.indexOf("claimant?.role !== 'patient'"))
      .toBeLessThan(PROXY.indexOf('await claimReferral'));
  });
});
