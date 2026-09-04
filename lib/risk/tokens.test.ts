import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  customerMerchantToken,
  internalToken,
  normalizeAccountNumber,
  normalizeEmail,
  normalizeEmailDomain,
  normalizeIp,
  normalizePhone,
  RiskKeyUnavailableError,
  riskToken,
} from './tokens';

// ─── Correlation tokens ─────────────────────────────────────────────────────
//
// Two properties, and each has a distinct failure mode:
//
//   NORMALISATION. A keyed hash is an equality test and nothing else, so two
//   spellings of one thing produce two tokens and the correlation SILENTLY
//   fails. That failure looks exactly like an absence of fraud, which is why
//   most of this file is spelling.
//
//   OPACITY. The store must not be joinable back to the tables that hold the
//   plaintext, or the whole thing is a re-identification database with a
//   90-day retention policy attached.

const KEY = 'RISK_CORRELATION_HMAC_KEY';
const SERVICE = 'SUPABASE_SERVICE_ROLE_KEY';

let savedKey: string | undefined;
let savedService: string | undefined;

beforeEach(() => {
  savedKey = process.env[KEY];
  savedService = process.env[SERVICE];
  process.env[KEY] = 'test-correlation-key';
});

afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY];      else process.env[KEY] = savedKey;
  if (savedService === undefined) delete process.env[SERVICE]; else process.env[SERVICE] = savedService;
});

describe('normalizeEmail / normalizeEmailDomain', () => {
  it('folds case and whitespace so one address is one token', () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com');
  });

  it('does NOT strip dots or plus-tags', () => {
    // Gmail merges these; most providers genuinely do not. Merging them here
    // would link two strangers on a provider that treats them as different
    // people, and a false link produces a false review of a real customer.
    expect(normalizeEmail('a.b+tag@example.com')).toBe('a.b+tag@example.com');
  });

  it('rejects a value with no @', () => {
    expect(normalizeEmail('not-an-address')).toBeNull();
  });

  it('takes the domain after the LAST @', () => {
    expect(normalizeEmailDomain('weird@name@mailinator.com')).toBe('mailinator.com');
  });
});

describe('normalizePhone', () => {
  it('folds the three SA spellings of one number into one token', () => {
    // The single most consequential normalisation in the file: a phone rule
    // that treats these as three numbers is not a phone rule.
    const local  = riskToken('phone', '082 123 4567');
    const e164   = riskToken('phone', '+27821234567');
    const intl00 = riskToken('phone', '0027821234567');
    expect(local).toBe(e164);
    expect(e164).toBe(intl00);
  });

  it('keeps a non-SA number as its digits', () => {
    expect(normalizePhone('+44 20 7946 0000')).toBe('442079460000');
  });

  it('rejects something too short to be a number', () => {
    expect(normalizePhone('12345')).toBeNull();
  });
});

describe('normalizeIp', () => {
  it('strips a port from a v4 address', () => {
    expect(normalizeIp('203.0.113.5:44321')).toBe('203.0.113.5');
  });

  it('strips brackets and a port from a v6 address', () => {
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
  });

  it('does not mistake a bare v6 address for a ported v4 one', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('strips a zone id', () => {
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('lowercases, so one address is one token', () => {
    expect(normalizeIp('2001:DB8::AB')).toBe('2001:db8::ab');
  });
});

describe('normalizeAccountNumber', () => {
  it('strips the spaces and dashes a human types', () => {
    expect(normalizeAccountNumber('1234 5678-90')).toBe('1234567890');
  });

  it('rejects a fragment too short to identify an account', () => {
    expect(normalizeAccountNumber('12')).toBeNull();
  });
});

describe('riskToken', () => {
  it('is deterministic — the same value always yields the same token', () => {
    expect(riskToken('device', 'abc')).toBe(riskToken('device', 'abc'));
  });

  it('separates dimensions, so one string in two dimensions is two tokens', () => {
    // Without this, an email that happens to equal a device id would link two
    // unrelated subjects, and a phone number reused as another kind of
    // subject would collide with itself.
    expect(riskToken('device', 'abc')).not.toBe(riskToken('email_domain', 'abc'));
  });

  it('is not the input, and does not contain it', () => {
    const token = riskToken('phone', '+27821234567')!;
    expect(token).not.toContain('27821234567');
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changes completely when the key changes — re-keying erases the graph', () => {
    const before = riskToken('device', 'abc');
    process.env[KEY] = 'a-different-key';
    expect(riskToken('device', 'abc')).not.toBe(before);
  });

  it('is not derivable without the key', () => {
    // The property that makes storing an SA ID blind index safe: an attacker
    // holding the store and the whole ~10^13 SA ID space still cannot match
    // them without the secret.
    const withKey = riskToken('identity', '9001015800085');
    process.env[KEY] = 'attacker-guess';
    expect(riskToken('identity', '9001015800085')).not.toBe(withKey);
  });

  it('returns null for an absent or unusable value rather than hashing emptiness', () => {
    // Every empty phone would otherwise become ONE shared token, linking
    // every customer who did not give one into a single cluster.
    expect(riskToken('phone', null)).toBeNull();
    expect(riskToken('phone', undefined)).toBeNull();
    expect(riskToken('phone', '   ')).toBeNull();
    expect(riskToken('email', 'nonsense')).toBeNull();
  });

  it('falls back to the service key when no dedicated key is set', () => {
    delete process.env[KEY];
    process.env[SERVICE] = 'service-key';
    expect(riskToken('device', 'abc')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('throws when there is no key material at all', () => {
    // Deliberately an exception rather than a null token. A null would make
    // the rules SKIP, turning a missing environment variable into "the fraud
    // controls are off" with no outward sign; evaluateRisk catches this and
    // applies the fail-closed posture instead.
    delete process.env[KEY];
    delete process.env[SERVICE];
    expect(() => riskToken('device', 'abc')).toThrow(RiskKeyUnavailableError);
  });
});

describe('customerMerchantToken', () => {
  it('is one token for the pair, and not either endpoint', () => {
    const edge = customerMerchantToken('patient-1', 'practice-1')!;
    expect(edge).not.toBe(riskToken('account', 'patient-1'));
    expect(edge).not.toBe(internalToken('practice-1'));
  });

  it('distinguishes the pair from the reversed pair', () => {
    expect(customerMerchantToken('a', 'b')).not.toBe(customerMerchantToken('b', 'a'));
  });

  it('is null unless both ends are present', () => {
    expect(customerMerchantToken('a', null)).toBeNull();
    expect(customerMerchantToken(null, 'b')).toBeNull();
  });
});

describe('internalToken', () => {
  it('passes an internal id through unhashed', () => {
    // The one exception to the tokenisation rule. These UUIDs are already in
    // plain sight on plans, payouts and bills; hashing them would buy no
    // privacy and would make the merchant-side queries unjoinable to the
    // records a reviewer needs to open next.
    expect(internalToken('  practice-1 ')).toBe('practice-1');
  });

  it('is null for an absent id', () => {
    expect(internalToken(null)).toBeNull();
    expect(internalToken('  ')).toBeNull();
  });
});
