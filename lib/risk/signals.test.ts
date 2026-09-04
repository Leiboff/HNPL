import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { collectRiskSignals } from './signals';
import { riskToken } from './tokens';

// ─── Gathering the signals ──────────────────────────────────────────────────
//
// Two things have to be true and they pull in opposite directions:
//
//   Everything the caller knows must reach the decision, TOKENISED.
//   Nothing that is merely the ABSENCE of knowledge may reach it as a shared
//   token — because a token every request carries is a key that clusters the
//   platform's whole legitimate traffic into one bucket, and any rule on it
//   then fires on ordinary customers.
//
// The second is the subtle one and it is why `network_class` is filtered.

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7' }),
  cookies: async () => ({ get: () => ({ value: 'a'.repeat(32) }), set: () => {} }),
}));

const ENV = ['RISK_CORRELATION_HMAC_KEY', 'RISK_HOSTING_CIDRS', 'RISK_PROXY_CIDRS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.RISK_CORRELATION_HMAC_KEY = 'test-correlation-key';
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('collectRiskSignals', () => {
  it('tokenises every explicit signal', async () => {
    const { signals } = await collectRiskSignals({
      accountId: 'acct-1',
      identityHash: 'blind-index',
      phone: '+27821234567',
      email: 'person@example.com',
      cardFingerprint: 'peach:VISA:4242:1230',
      bankAccount: '1234567890',
    });

    expect(signals.identity).toBe(riskToken('identity', 'blind-index'));
    expect(signals.phone).toBe(riskToken('phone', '+27821234567'));
    expect(signals.email).toBe(riskToken('email', 'person@example.com'));
    expect(signals.email_domain).toBe(riskToken('email_domain', 'person@example.com'));
    expect(signals.card).toBe(riskToken('card', 'peach:VISA:4242:1230'));
    expect(signals.bank_account).toBe(riskToken('bank_account', '1234567890'));
  });

  it('derives the network dimensions from the ambient request', async () => {
    const { signals } = await collectRiskSignals({});
    expect(signals.ip).toBe(riskToken('ip', '203.0.113.7'));
    expect(signals.subnet).toBe(riskToken('subnet', '203.0.113.0/24'));
  });

  it('does NOT record an unknown or residential network class', async () => {
    // The failure this prevents is a platform-wide outage rather than a
    // missed detection. Every ordinary request carries one of these two, so
    // recording them would put the whole legitimate traffic of the platform
    // under a single token — and the class rules, sized for "40 requests from
    // data centres in an hour", would then hold every customer for review on
    // the first busy morning.
    const { signals } = await collectRiskSignals({});
    expect(signals.network_class).toBeUndefined();
  });

  it('DOES record hosting and proxy, which are findings rather than absences', async () => {
    process.env.RISK_HOSTING_CIDRS = '203.0.113.0/24';
    const hosting = await collectRiskSignals({});
    expect(hosting.signals.network_class).toBe(riskToken('network_class', 'hosting'));

    delete process.env.RISK_HOSTING_CIDRS;
    process.env.RISK_PROXY_CIDRS = '203.0.113.0/24';
    const proxy = await collectRiskSignals({});
    expect(proxy.signals.network_class).toBe(riskToken('network_class', 'proxy'));
  });

  it('builds the customer-merchant edge only when both ends are present', async () => {
    const both = await collectRiskSignals({ accountId: 'a', practiceId: 'p' });
    expect(both.signals.customer_merchant).toBeTruthy();

    const one = await collectRiskSignals({ accountId: 'a' });
    expect(one.signals.customer_merchant).toBeUndefined();
  });

  it('passes internal ids through unhashed', async () => {
    const { signals } = await collectRiskSignals({
      practiceId: 'practice-1', practiceGroupId: 'group-1', providerId: 'member-1',
    });
    expect(signals.practice).toBe('practice-1');
    expect(signals.practice_group).toBe('group-1');
    expect(signals.provider).toBe('member-1');
  });

  it('omits a signal the caller did not supply, and names it only if asked for', async () => {
    const { signals, unresolved } = await collectRiskSignals({});
    expect(signals.card).toBeUndefined();
    // Not requested, so not reported as a gap — otherwise every signup would
    // emit a warning about a card the customer does not have yet.
    expect(unresolved).not.toContain('card');
  });

  it('reports a supplied signal that failed to normalise, so the gap is measurable', async () => {
    const { signals, unresolved } = await collectRiskSignals({ phone: '123' });
    expect(signals.phone).toBeUndefined();
    expect(unresolved).toContain('phone');
  });

  it('skips the device for a background job rather than minting a cookie nobody asked for', async () => {
    const withDevice = await collectRiskSignals({});
    expect(withDevice.signals.device).toBeTruthy();

    const withoutDevice = await collectRiskSignals({ skipDevice: true });
    expect(withoutDevice.signals.device).toBeUndefined();
    expect(withoutDevice.unresolved).not.toContain('device');
  });

  it('honours an explicit IP override for callers that already resolved one', async () => {
    const { signals } = await collectRiskSignals({ ip: '198.51.100.42' });
    expect(signals.ip).toBe(riskToken('ip', '198.51.100.42'));
    expect(signals.subnet).toBe(riskToken('subnet', '198.51.100.0/24'));
  });

  it('never returns a raw identifier in the map', async () => {
    const { signals } = await collectRiskSignals({
      accountId: 'acct-1', phone: '+27821234567', email: 'person@example.com',
      identityHash: 'blind-index',
    });
    const serialised = JSON.stringify(signals);
    for (const raw of ['acct-1', '27821234567', 'person@example.com', 'blind-index', '203.0.113']) {
      expect(serialised, raw).not.toContain(raw);
    }
  });
});
