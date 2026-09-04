// ─── Network dimensions: subnet, ASN and reputation ─────────────────────
//
// An IP address is the cheapest identifier a ring rotates and the one every
// existing limit in this codebase keys on. Three derived dimensions make
// that rotation cost something:
//
//   subnet         /24 (v4) or /48 (v6). What a VPN hop moves WITHIN. A
//                  provider hands out neighbouring addresses from the same
//                  block, so an attacker who reconnects for a fresh IP
//                  usually keeps the subnet.
//   asn            The autonomous system. What a ring must PAY to move
//                  between: a different hosting provider, a different mobile
//                  network. Rotation here is real friction.
//   network_class  hosting / proxy / residential / unknown. Not an identity
//                  at all — a shared token, so "40 signups from hosting
//                  networks this hour" is one countable thing.
//
// ─── ON SPAN OF CONTROL, STATED PLAINLY ─────────────────────────────────
//
// ASN and hosting/proxy reputation are not derivable from an IP address
// alone. They need either a platform header or a maintained IP-intelligence
// feed, and this module deliberately does NOT pretend otherwise:
//
//   • On Vercel, `x-vercel-ip-asn` carries the ASN when the account's plan
//     provides it. Read when present, absent otherwise — no guessing.
//   • Beyond that, classification comes from operator-maintained lists in
//     the environment (RISK_HOSTING_ASNS, RISK_HOSTING_CIDRS,
//     RISK_PROXY_CIDRS). Empty by default.
//
// So on a deployment with neither, `asn` is null and `network_class` is
// 'unknown' — the ASN rules skip, and the subnet and device rules carry the
// weight. That is the honest behaviour, and it is why the operations doc
// lists an IP-intelligence feed as a prerequisite rather than this file
// shipping a stale copy of one.
//
// ─── ADDRESSES AS 16-BIT GROUPS ─────────────────────────────────────────
//
// Both families are parsed into an array of 16-bit groups — two for IPv4,
// eight for IPv6 — so one prefix comparison serves both and no arithmetic
// ever exceeds a safe integer. (BigInt would read more naturally; the
// project targets ES2017, where BigInt literals are a compile error.)

import { normalizeIp } from './tokens';

export type NetworkClass = 'hosting' | 'proxy' | 'residential' | 'unknown';

export type NetworkFacts = {
  ip: string | null;
  subnet: string | null;
  asn: string | null;
  networkClass: NetworkClass;
};

type ParsedAddress = { groups: number[]; v4: boolean };

// ─── Address parsing ────────────────────────────────────────────────────

function ipv4Groups(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
}

/**
 * IPv6 as eight 16-bit groups. Handles `::` compression and the IPv4-mapped
 * tail (`::ffff:1.2.3.4`), which is what a dual-stack proxy hands over for a
 * v4 client and which would otherwise fail to parse and silently drop that
 * client out of every network rule.
 */
function ipv6Groups(ip: string): number[] | null {
  let work = ip;

  const lastColon = work.lastIndexOf(':');
  if (lastColon >= 0 && work.slice(lastColon + 1).includes('.')) {
    const mapped = ipv4Groups(work.slice(lastColon + 1));
    if (!mapped) return null;
    work = `${work.slice(0, lastColon + 1)}${mapped[0].toString(16)}:${mapped[1].toString(16)}`;
  }

  const halves = work.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];

  let parts: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    parts = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    parts = [...head, ...Array<string>(fill).fill('0'), ...tail];
  }
  if (parts.length !== 8) return null;

  const groups: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

function parseAddress(rawIp: string): ParsedAddress | null {
  const ip = normalizeIp(rawIp);
  if (!ip) return null;
  const v4 = ipv4Groups(ip);
  if (v4) return { groups: v4, v4: true };
  const v6 = ipv6Groups(ip);
  return v6 ? { groups: v6, v4: false } : null;
}

/** Do two addresses agree on their first `bits` bits? */
function prefixEquals(a: number[], b: number[], bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < a.length && remaining > 0; i += 1) {
    const take = Math.min(16, remaining);
    const shift = 16 - take;
    if ((a[i] >> shift) !== (b[i] >> shift)) return false;
    remaining -= take;
  }
  return true;
}

/**
 * The subnet an address belongs to, as a stable string.
 *
 * /24 for v4 and /48 for v6 are the conventional "one customer allocation"
 * boundaries. Wider would sweep a whole ISP into one bucket and lock out a
 * city; narrower would be defeated by the single reconnect that hands a
 * dial-up client its neighbour's address.
 */
export function subnetOf(rawIp: string | null | undefined): string | null {
  if (!rawIp) return null;
  const parsed = parseAddress(rawIp);
  if (!parsed) return null;

  if (parsed.v4) {
    const a = parsed.groups[0] >> 8;
    const b = parsed.groups[0] & 0xff;
    const c = parsed.groups[1] >> 8;
    return `${a}.${b}.${c}.0/24`;
  }

  const [h1, h2, h3] = parsed.groups;
  return `${h1.toString(16)}:${h2.toString(16)}:${h3.toString(16)}::/48`;
}

// ─── CIDR matching ──────────────────────────────────────────────────────

function parseCidr(entry: string): { address: ParsedAddress; bits: number } | null {
  const [addr, prefix] = entry.trim().split('/');
  const address = parseAddress(addr ?? '');
  if (!address) return null;

  const width = address.v4 ? 32 : 128;
  const bits = prefix === undefined ? width : Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  return { address, bits };
}

export function ipInCidr(rawIp: string, cidr: string): boolean {
  const parsedCidr = parseCidr(cidr);
  if (!parsedCidr) return false;
  const parsedIp = parseAddress(rawIp);
  if (!parsedIp) return false;
  // A v4 address is never inside a v6 range and vice versa. Comparing them
  // would silently succeed on the shared leading zeroes.
  if (parsedIp.v4 !== parsedCidr.address.v4) return false;
  return prefixEquals(parsedIp.groups, parsedCidr.address.groups, parsedCidr.bits);
}

// ─── Operator-maintained reputation lists ───────────────────────────────

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}

/**
 * The ASN, from the platform header when the deployment provides one.
 *
 * Not inferred from the address. An ASN guessed from a stale table is worse
 * than no ASN: the rule fires on the wrong subject and a reviewer chases a
 * network that was reassigned two years ago.
 */
export function asnFromHeaders(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  const raw = headers.get('x-vercel-ip-asn')?.trim();
  if (!raw) return null;
  // Normalise "AS12345" and "12345" to one form.
  const digits = raw.replace(/^as/i, '').replace(/\D+/g, '');
  return digits.length ? `AS${digits}` : null;
}

/**
 * hosting / proxy / residential / unknown.
 *
 * 'residential' is claimed ONLY when an ASN is known and appears on neither
 * list — with no ASN there is nothing to base the claim on, and calling an
 * unclassified address residential would hand every unclassifiable ring the
 * most trusted label available.
 */
export function classifyNetwork(
  rawIp: string | null | undefined,
  asn: string | null,
): NetworkClass {
  const ip = rawIp ? normalizeIp(rawIp) : null;

  const hostingAsns = envList('RISK_HOSTING_ASNS').map((a) => a.replace(/^as/i, ''));
  if (asn && hostingAsns.includes(asn.replace(/^AS/, ''))) return 'hosting';

  if (ip) {
    if (envList('RISK_HOSTING_CIDRS').some((c) => ipInCidr(ip, c))) return 'hosting';
    if (envList('RISK_PROXY_CIDRS').some((c) => ipInCidr(ip, c)))   return 'proxy';
  }

  return asn ? 'residential' : 'unknown';
}

/** Everything the network dimensions need, from one request. */
export function networkFacts(
  rawIp: string | null | undefined,
  headers: Headers | null | undefined,
): NetworkFacts {
  const ip  = rawIp ? normalizeIp(rawIp) : null;
  const asn = asnFromHeaders(headers);
  return {
    ip,
    subnet: subnetOf(ip),
    asn,
    networkClass: classifyNetwork(ip, asn),
  };
}
