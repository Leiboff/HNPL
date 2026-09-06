import { describe, it, expect } from 'vitest';
import {
  REFERRAL_QUERY_PARAM,
  referralLink,
  readReferralParam,
  referralShareMessage,
} from './link';

describe('referralLink', () => {
  it('hangs the code off the landing page, not the signup form', () => {
    // A referred arrival is a cold visitor who has been told one sentence
    // about us. The landing page answers the question they have; the code
    // survives the hop to signup in a cookie.
    expect(referralLink('A2C4K9PT', 'https://app.betternow.co.za'))
      .toBe('https://app.betternow.co.za/?ref=A2C4K9PT');
  });

  it('tolerates a trailing slash on the origin', () => {
    expect(referralLink('A2C4K9PT', 'https://app.betternow.co.za/'))
      .toBe('https://app.betternow.co.za/?ref=A2C4K9PT');
  });

  it('works against a localhost origin', () => {
    expect(referralLink('A2C4K9PT', 'http://localhost:3000'))
      .toBe('http://localhost:3000/?ref=A2C4K9PT');
  });
});

describe('readReferralParam', () => {
  it('reads a well-formed code', () => {
    expect(readReferralParam(new URLSearchParams('ref=A2C4K9PT'))).toBe('A2C4K9PT');
  });

  it('upper-cases what it finds', () => {
    expect(readReferralParam(new URLSearchParams('ref=a2c4k9pt'))).toBe('A2C4K9PT');
  });

  it('returns null when the parameter is absent or empty', () => {
    expect(readReferralParam(new URLSearchParams(''))).toBeNull();
    expect(readReferralParam(new URLSearchParams('ref='))).toBeNull();
    expect(readReferralParam(new URLSearchParams('other=A2C4K9PT'))).toBeNull();
  });

  it('refuses anything that is not code-shaped, however long', () => {
    // This is the value that ends up in a cookie. The character class and the
    // fixed length are the reason a hostile query string cannot push
    // arbitrary text — a 4KB string, a newline, a header injection attempt —
    // into a Set-Cookie header.
    const hostile = [
      'x'.repeat(5000),
      'A2C4K9PT\nSet-Cookie: admin=1',
      '../../etc/passwd',
      '<script>alert(1)</script>',
      "' OR 1=1--",
    ];
    for (const value of hostile) {
      const params = new URLSearchParams();
      params.set(REFERRAL_QUERY_PARAM, value);
      expect(readReferralParam(params), `accepted: ${value.slice(0, 24)}`).toBeNull();
    }
  });
});

describe('referralShareMessage', () => {
  it('carries the link', () => {
    const link = 'https://app.betternow.co.za/?ref=A2C4K9PT';
    expect(referralShareMessage(link)).toContain(link);
  });

  it('promises no reward, because there is no incentive programme', () => {
    // This is the string a customer forwards to their friends and the one
    // that gets screenshotted. Promising a reward the platform cannot pay is
    // the single most expensive thing this file could do.
    // 'interest-free' is removed before the check rather than exempted in the
    // pattern: it is a product FACT (the instalments carry no interest), not
    // an offer, and leaving it in would make /free/ unusable as a guard.
    const message = referralShareMessage('https://example.test/?ref=A2C4K9PT')
      .replace(/interest-free/gi, '');
    expect(message).not.toMatch(/reward|bonus|R\d|discount|cashback|credit|free|earn/i);
  });
});
