import { describe, it, expect } from 'vitest';
import {
  REFERRAL_QUERY_PARAM,
  REFERRAL_EMAIL_SUBJECT,
  referralLink,
  readReferralParam,
  referralShareMessage,
  whatsappShareUrl,
  emailShareUrl,
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


describe('the named share channels', () => {
  // These carry the whole feature on a browser with no share sheet — desktop
  // Firefox, desktop Chrome without OS integration, most embedded webviews.
  const LINK = 'https://app.betternow.co.za/?ref=A2C4K9PT';
  const MESSAGE = referralShareMessage(LINK);

  it('WhatsApp opens the contact picker rather than a conversation', () => {
    // wa.me with NO number is the documented form for "share to a chat you
    // pick". A number in the path would open a conversation with whoever we
    // put there, which is not a share.
    const url = whatsappShareUrl(MESSAGE);
    expect(url.startsWith('https://wa.me/?text=')).toBe(true);
    expect(url).not.toMatch(/wa\.me\/\d/);
  });

  it('email opens a draft with no recipient — the person picks that', () => {
    const url = emailShareUrl(MESSAGE);
    expect(url.startsWith('mailto:?')).toBe(true);
    expect(url).toContain(`subject=${encodeURIComponent(REFERRAL_EMAIL_SUBJECT)}`);
  });

  it('both encode the message rather than splicing it in raw', () => {
    // The message contains a URL with its own ? and =. Unencoded, everything
    // after the first & would be read as another mailto header — which is the
    // classic mailto header-injection shape, and is also just broken.
    const hostile = referralShareMessage('https://app.test/?ref=A2C4K9PT&x=1')
      + '\n\nBcc: someone@example.test';
    for (const url of [whatsappShareUrl(hostile), emailShareUrl(hostile)]) {
      expect(url).not.toContain('\n');
      expect(url).not.toContain('Bcc:');
      expect(url).toContain(encodeURIComponent('Bcc: someone@example.test'));
    }
  });

  it('every channel sends the SAME message', () => {
    // One pitch, reviewable once. A per-channel string is how a promise nobody
    // approved ends up in one of them.
    for (const url of [whatsappShareUrl(MESSAGE), emailShareUrl(MESSAGE)]) {
      expect(decodeURIComponent(url)).toContain(MESSAGE);
    }
  });

  it('and none of them promises a reward either', () => {
    const decoded = decodeURIComponent(`${whatsappShareUrl(MESSAGE)} ${emailShareUrl(MESSAGE)}`)
      .replace(/interest-free/gi, '');
    expect(decoded).not.toMatch(/reward|bonus|R\d|discount|cashback|credit|free|earn/i);
  });
});
