import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { asnFromHeaders, classifyNetwork, ipInCidr, networkFacts, subnetOf } from './network';

// ─── The network dimensions ─────────────────────────────────────────────────
//
// The subnet is the one that has to be right. It is what turns "rotate your
// IP" from free into "get an address in a different allocation", and both
// failure directions are expensive:
//
//   too wide   sweeps a whole ISP into one bucket and locks out a city
//   too narrow is defeated by one reconnect that hands out a neighbour's
//              address, which is the default behaviour of most ISPs

const ENV_KEYS = ['RISK_HOSTING_ASNS', 'RISK_HOSTING_CIDRS', 'RISK_PROXY_CIDRS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('subnetOf', () => {
  it('groups a v4 address to its /24', () => {
    expect(subnetOf('203.0.113.7')).toBe('203.0.113.0/24');
    expect(subnetOf('203.0.113.250')).toBe('203.0.113.0/24');
  });

  it('separates neighbouring /24s', () => {
    expect(subnetOf('203.0.113.7')).not.toBe(subnetOf('203.0.114.7'));
  });

  it('groups a v6 address to its /48', () => {
    expect(subnetOf('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
  });

  it('treats two addresses in one v6 /48 as one subnet', () => {
    // The case that matters: a v6 client is routinely handed a fresh /64 or
    // a fresh address per connection, so anything narrower than /48 makes
    // the v6 subnet rule free to defeat.
    expect(subnetOf('2001:db8:1234:aaaa::1')).toBe(subnetOf('2001:db8:1234:bbbb::9'));
  });

  it('handles a compressed v6 address', () => {
    expect(subnetOf('2001:db8::1')).toBe('2001:db8:0::/48');
  });

  it('handles an IPv4-mapped v6 address rather than dropping the client', () => {
    // A dual-stack proxy hands this over for a v4 client. Failing to parse it
    // would silently drop that client out of every network rule.
    expect(subnetOf('::ffff:203.0.113.7')).toBe('0:0:0::/48');
  });

  it('returns null for a value that is not an address', () => {
    expect(subnetOf('not-an-ip')).toBeNull();
    expect(subnetOf(null)).toBeNull();
    expect(subnetOf('999.1.1.1')).toBeNull();
  });
});

describe('ipInCidr', () => {
  it('matches inside a v4 range and not outside it', () => {
    expect(ipInCidr('203.0.113.7', '203.0.113.0/24')).toBe(true);
    expect(ipInCidr('203.0.114.7', '203.0.113.0/24')).toBe(false);
  });

  it('handles a non-octet-aligned prefix', () => {
    // /20 spans 203.0.112.0–203.0.127.255. A byte-wise comparison would get
    // this wrong and quietly mis-scope every operator list that uses one.
    expect(ipInCidr('203.0.120.1', '203.0.112.0/20')).toBe(true);
    expect(ipInCidr('203.0.128.1', '203.0.112.0/20')).toBe(false);
  });

  it('treats a bare address as a /32 or /128', () => {
    expect(ipInCidr('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(ipInCidr('203.0.113.8', '203.0.113.7')).toBe(false);
  });

  it('matches inside a v6 range', () => {
    expect(ipInCidr('2001:db8:1234::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1',      '2001:db8::/32')).toBe(false);
  });

  it('never matches a v4 address against a v6 range', () => {
    // Both begin with a run of zero bits, so a family-blind comparison would
    // report every v4 address as inside ::/8 and classify the whole internet.
    expect(ipInCidr('203.0.113.7', '::/8')).toBe(false);
    expect(ipInCidr('2001:db8::1', '0.0.0.0/0')).toBe(false);
  });

  it('rejects a malformed range rather than matching everything', () => {
    expect(ipInCidr('203.0.113.7', 'nonsense/24')).toBe(false);
    expect(ipInCidr('203.0.113.7', '203.0.113.0/99')).toBe(false);
  });
});

describe('asnFromHeaders', () => {
  it('reads the platform header and normalises its two spellings', () => {
    expect(asnFromHeaders(new Headers({ 'x-vercel-ip-asn': 'AS12345' }))).toBe('AS12345');
    expect(asnFromHeaders(new Headers({ 'x-vercel-ip-asn': '12345' }))).toBe('AS12345');
  });

  it('is null when the deployment provides no ASN', () => {
    // Honest absence. An ASN guessed from a stale table is worse than none:
    // the rule fires on the wrong subject and a reviewer chases a network
    // that was reassigned two years ago.
    expect(asnFromHeaders(new Headers())).toBeNull();
    expect(asnFromHeaders(null)).toBeNull();
  });
});

describe('classifyNetwork', () => {
  it('is "unknown" with no ASN and no operator lists', () => {
    // The default on a deployment that has bought no IP intelligence. The
    // class rules then aggregate all such traffic under one token, which is
    // still useful, and nothing is claimed that is not known.
    expect(classifyNetwork('203.0.113.7', null)).toBe('unknown');
  });

  it('is "residential" only when an ASN is known and on neither list', () => {
    // Never claimed on an unclassifiable address: doing so would hand every
    // unclassifiable ring the most trusted label available.
    expect(classifyNetwork('203.0.113.7', 'AS12345')).toBe('residential');
    expect(classifyNetwork('203.0.113.7', null)).not.toBe('residential');
  });

  it('is "hosting" for an ASN on the operator list', () => {
    process.env.RISK_HOSTING_ASNS = 'AS16509, 14061';
    expect(classifyNetwork('203.0.113.7', 'AS16509')).toBe('hosting');
    expect(classifyNetwork('203.0.113.7', 'AS14061')).toBe('hosting');
    expect(classifyNetwork('203.0.113.7', 'AS99999')).toBe('residential');
  });

  it('is "hosting" for an address in an operator CIDR, with no ASN needed', () => {
    process.env.RISK_HOSTING_CIDRS = '203.0.113.0/24';
    expect(classifyNetwork('203.0.113.7', null)).toBe('hosting');
    expect(classifyNetwork('198.51.100.7', null)).toBe('unknown');
  });

  it('is "proxy" for an address in the proxy list', () => {
    process.env.RISK_PROXY_CIDRS = '198.51.100.0/24';
    expect(classifyNetwork('198.51.100.7', null)).toBe('proxy');
  });

  it('prefers hosting over proxy when an address is on both lists', () => {
    // Arbitrary but fixed: the classification is a shared token, so it has to
    // be a function of the address and not of list ordering.
    process.env.RISK_HOSTING_CIDRS = '198.51.100.0/24';
    process.env.RISK_PROXY_CIDRS   = '198.51.100.0/24';
    expect(classifyNetwork('198.51.100.7', null)).toBe('hosting');
  });
});

describe('networkFacts', () => {
  it('derives everything one request needs from an address and its headers', () => {
    process.env.RISK_HOSTING_ASNS = '16509';
    const facts = networkFacts('203.0.113.7', new Headers({ 'x-vercel-ip-asn': 'AS16509' }));
    expect(facts).toEqual({
      ip: '203.0.113.7',
      subnet: '203.0.113.0/24',
      asn: 'AS16509',
      networkClass: 'hosting',
    });
  });

  it('degrades to nulls and "unknown" when there is no address', () => {
    // A background job, or a request whose proxy headers did not arrive. The
    // network rules then skip; nothing throws and nothing is invented.
    expect(networkFacts(null, null)).toEqual({
      ip: null, subnet: null, asn: null, networkClass: 'unknown',
    });
  });
});
