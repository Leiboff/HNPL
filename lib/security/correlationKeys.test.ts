import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';
import { correlationKey, normalizeEmailAlias, ipSubnet } from './correlationKeys';

// A key is required for every test here — the module fails closed without
// one, which is itself asserted below.
beforeAll(() => {
  process.env.CORRELATION_HMAC_KEY = randomBytes(32).toString('base64');
});

describe('the keys are blind', () => {
  it('never emits the input value', () => {
    const ip = '196.25.1.77';
    const key = correlationKey('ip', ip)!;
    expect(key).not.toContain(ip);
    expect(key).not.toContain('196');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — the same value collides, which is the whole point', () => {
    expect(correlationKey('device', 'abc-123')).toBe(correlationKey('device', 'abc-123'));
  });

  it('separates domains — the same string in two roles never collides', () => {
    // Without the domain tag, a device id that happened to equal an email
    // would link two unrelated applicants. A match must mean what it says.
    expect(correlationKey('device', 'shared')).not.toBe(correlationKey('card', 'shared'));
    expect(correlationKey('ip', '10.0.0.1')).not.toBe(correlationKey('subnet', '10.0.0.1'));
  });

  it('is unrentable — a different key yields a different hash for the same input', () => {
    // The property that makes this a blind index rather than a lookup
    // table. A bare SHA-256 of an IPv4 address is a 2^32 brute-force; keyed,
    // an attacker who guesses the value cannot confirm the guess.
    const withFirstKey = correlationKey('ip', '196.25.1.77');
    process.env.CORRELATION_HMAC_KEY = randomBytes(32).toString('base64');
    expect(correlationKey('ip', '196.25.1.77')).not.toBe(withFirstKey);
  });
});

describe('absent signals never become shared signals', () => {
  // The bug this guards: hashing '' produces a real, colliding value, so
  // every applicant missing a signal would link to every other one — a
  // fabricated ring containing most of the customer base.
  it('returns null rather than hashing nothing', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(correlationKey('device', empty as string | null | undefined)).toBeNull();
    }
  });

  it('returns null for values that cannot be normalised', () => {
    expect(correlationKey('phone', 'not-a-number')).toBeNull();
    expect(correlationKey('email', 'no-at-sign')).toBeNull();
    expect(correlationKey('subnet', '999.1.1.1')).toBeNull();
  });
});

describe('fails closed without a key', () => {
  it('throws rather than silently falling back to an unkeyed hash', () => {
    const saved = process.env.CORRELATION_HMAC_KEY;
    delete process.env.CORRELATION_HMAC_KEY;
    expect(() => correlationKey('ip', '196.25.1.77')).toThrow(/CORRELATION_HMAC_KEY/);
    process.env.CORRELATION_HMAC_KEY = saved;
  });

  it('rejects a key of the wrong length', () => {
    const saved = process.env.CORRELATION_HMAC_KEY;
    process.env.CORRELATION_HMAC_KEY = Buffer.from('short').toString('base64');
    expect(() => correlationKey('ip', '196.25.1.77')).toThrow(/32 bytes/);
    process.env.CORRELATION_HMAC_KEY = saved;
  });
});

describe('email alias normalisation', () => {
  it('collapses the three farming tricks on Gmail', () => {
    const canonical = normalizeEmailAlias('bob@gmail.com');
    for (const alias of ['BOB@Gmail.com', 'b.o.b@gmail.com', 'bob+plan1@gmail.com', 'B.O.B+x@GMAIL.COM']) {
      expect(normalizeEmailAlias(alias), alias).toBe(canonical);
    }
  });

  it('strips +tags on every host, since subaddressing is near-universal', () => {
    expect(normalizeEmailAlias('sipho+1@outlook.com')).toBe('sipho@outlook.com');
  });

  it('does NOT strip dots outside Google — two colleagues are not one person', () => {
    // Over-linking is not a free mistake: it can freeze a real patient out
    // of credit. john.smith@ and johnsmith@ are different people at most
    // corporate hosts.
    expect(normalizeEmailAlias('john.smith@company.co.za'))
      .not.toBe(normalizeEmailAlias('johnsmith@company.co.za'));
  });

  it('rejects an address with no mailbox left after stripping', () => {
    expect(normalizeEmailAlias('+tag@gmail.com')).toBeNull();
    expect(normalizeEmailAlias('@gmail.com')).toBeNull();
    expect(normalizeEmailAlias('bob@')).toBeNull();
  });

  it('uses the LAST @ so a quoted local part cannot split the host', () => {
    expect(normalizeEmailAlias('a@b@gmail.com')).toBe('a@b@gmail.com');
  });
});

describe('ipSubnet', () => {
  it('reduces IPv4 to the /24 an attacker must actually leave', () => {
    expect(ipSubnet('196.25.1.77')).toBe('196.25.1.0/24');
    expect(ipSubnet('196.25.1.9')).toBe(ipSubnet('196.25.1.250'));
    expect(ipSubnet('196.25.2.9')).not.toBe(ipSubnet('196.25.1.9'));
  });

  it('reduces IPv6 to the /48 a residential customer is delegated', () => {
    expect(ipSubnet('2001:0db8:85a3:1234:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3::/48');
  });

  it('unwraps IPv4-mapped IPv6 so one client is not two subnets', () => {
    expect(ipSubnet('::ffff:196.25.1.77')).toBe('196.25.1.0/24');
  });

  it('rejects malformed addresses rather than inventing a subnet', () => {
    for (const bad of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.999']) {
      expect(ipSubnet(bad), bad).toBeNull();
    }
  });
});
