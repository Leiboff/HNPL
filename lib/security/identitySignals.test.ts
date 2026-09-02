import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import { keySignals, __resetKeyWarningForTests } from './identitySignals';

// ─── The I/O layer's own invariants ─────────────────────────────────────
//
// identityGraph.test.ts covers the decision and the migration tests cover
// the SQL. What is left is the seam between them, where two mistakes would
// be invisible: hashing a value the ledger should never see, and degrading
// silently when the key is gone.

const KEY = randomBytes(32).toString('base64');

beforeEach(() => {
  process.env.CORRELATION_HMAC_KEY = KEY;
  __resetKeyWarningForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('no raw value ever leaves this layer', () => {
  it('emits only hashes, never the inputs', () => {
    const raw = {
      deviceId: 'device-abcdef0123456789',
      ip:       '196.25.1.77',
      email:    'sipho@gmail.com',
      phone:    '0821234567',
      cardFingerprint: 'peach:VISA:4321:052028',
    };
    const signals = keySignals(raw);
    const blob = JSON.stringify(signals);

    for (const value of Object.values(raw)) {
      expect(blob).not.toContain(value);
    }
    for (const s of signals) expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives both an exact-IP and a subnet key from one address', () => {
    // Different weights in the graph — an address is reassigned constantly,
    // the network is what an attacker has to actually leave.
    const kinds = keySignals({ ip: '196.25.1.77' }).map((s) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(['ip', 'subnet']));
  });

  it('gives the two IP keys different hashes', () => {
    const signals = keySignals({ ip: '196.25.1.77' });
    const ip     = signals.find((s) => s.kind === 'ip')!;
    const subnet = signals.find((s) => s.kind === 'subnet')!;
    expect(ip.hash).not.toBe(subnet.hash);
  });
});

describe('absent signals never become shared signals', () => {
  it('emits nothing for an empty observation', () => {
    expect(keySignals({})).toEqual([]);
  });

  it('skips only the unusable fields, keeping the rest', () => {
    // The bug this guards: one malformed field must not discard the
    // signals that were fine, and must not become a shared empty key.
    const signals = keySignals({ deviceId: 'dev-1', phone: 'not-a-number', email: '' });
    expect(signals.map((s) => s.kind)).toEqual(['device']);
  });
});

describe('a missing key is loud, not silent', () => {
  it('records nothing and says so', () => {
    delete process.env.CORRELATION_HMAC_KEY;

    expect(keySignals({ deviceId: 'dev-1', ip: '196.25.1.77' })).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('ring detection is OFF'),
      expect.anything(),
    );
  });

  it('warns once per process, not once per request', () => {
    delete process.env.CORRELATION_HMAC_KEY;
    for (let i = 0; i < 5; i++) keySignals({ deviceId: 'dev-1' });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('never falls back to an unkeyed hash', () => {
    // A silent downgrade would make the ledger brute-forceable: a bare
    // SHA-256 of an IPv4 address is a 2^32 search.
    delete process.env.CORRELATION_HMAC_KEY;
    expect(keySignals({ ip: '196.25.1.77' })).toHaveLength(0);
  });
});
