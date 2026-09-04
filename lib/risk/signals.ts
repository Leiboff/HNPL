// ─── Gathering the signals for one request ──────────────────────────────
//
// Turns whatever a call site knows into the tokenised signal map
// `evaluate_risk` takes. Two sources:
//
//   • Ambient — the client IP, the derived subnet/ASN/network class, and the
//     device cookie. Read here so no call site has to know how, and so all
//     of them read it the same way.
//   • Explicit — the email, phone, identity index, card fingerprint,
//     practice, payout destination and so on that only the caller has.
//
// Everything is tokenised on the way out (lib/risk/tokens.ts). A raw
// identifier never leaves this module.
//
// ─── ABSENCE IS NOT FAILURE ─────────────────────────────────────────────
//
// A signal that cannot be resolved is simply not in the map, and 0142's rule
// loop skips rules whose dimension has no token. That is deliberate and it
// is the difference between a control and an outage: a first-time visitor
// has no device cookie, a patient at signup has no card, a deployment
// without an IP-intelligence feed has no ASN. Refusing on absence would deny
// every new customer on their first request.
//
// What absence must not be is INVISIBLE. `unresolved` on the result names
// every dimension the caller asked for and could not get, and evaluateRisk
// carries it into the telemetry — so "the device rule never fires" shows up
// as a measurable gap rather than as quiet good news.

import {
  customerMerchantToken,
  internalToken,
  riskToken,
} from './tokens';
import { networkFacts } from './network';
import { resolveDeviceId } from './device';
import type { RiskDimension } from './vocabulary';

/** What a call site knows. Everything is optional — surfaces differ. */
export type RiskSignalInput = {
  accountId?: string | null;
  /** The SA ID blind index (profiles.sa_id_lookup_hash), NOT the ID. */
  identityHash?: string | null;
  phone?: string | null;
  email?: string | null;
  /** A verification session id or portrait signal from the KYC provider. */
  kycSessionRef?: string | null;
  /** lib/payments/peach/saveCardForPatient.ts's synthetic fingerprint. */
  cardFingerprint?: string | null;
  /** A payout destination: the practice's bank account number. */
  bankAccount?: string | null;
  practiceId?: string | null;
  practiceGroupId?: string | null;
  providerId?: string | null;
  /**
   * Override the ambient IP. Only for callers that already resolved it (the
   * webhook and cron paths, which have a request but not this one) — leave
   * unset on ordinary server actions so the shared reader is used.
   */
  ip?: string | null;
  /** Skip the device cookie. Set by background jobs, which have no device
   *  and must not mint a cookie for a request nobody made. */
  skipDevice?: boolean;
};

export type CollectedSignals = {
  signals: Partial<Record<RiskDimension, string>>;
  /** Dimensions the caller supplied a value for that did not resolve, plus
   *  the ambient ones that were expected and missing. Telemetry only. */
  unresolved: RiskDimension[];
  /** Kept out of `signals` — it is not a correlation key, it is context for
   *  the reviewer and for the alert. */
  networkClass: string;
};

async function ambientIp(override: string | null | undefined): Promise<{
  ip: string | null;
  headers: Headers | null;
}> {
  if (override) return { ip: override, headers: null };
  try {
    const { headers } = await import('next/headers');
    const h = await headers();
    // Deliberately the same extraction as lib/security/rateLimit.ts's
    // clientIpFrom: two readings of "the client's address" that disagree
    // would put the rate limiter and the risk engine on different subjects.
    const fwd = h.get('x-forwarded-for');
    const first = fwd?.split(',')[0]?.trim();
    return { ip: first || h.get('x-real-ip')?.trim() || null, headers: h };
  } catch {
    return { ip: null, headers: null };
  }
}

export async function collectRiskSignals(
  input: RiskSignalInput,
): Promise<CollectedSignals> {
  const signals: Partial<Record<RiskDimension, string>> = {};
  const unresolved: RiskDimension[] = [];

  const put = (
    dimension: RiskDimension,
    token: string | null,
    requested: boolean,
  ): void => {
    if (token) signals[dimension] = token;
    else if (requested) unresolved.push(dimension);
  };

  const { ip, headers } = await ambientIp(input.ip);
  const net = networkFacts(ip, headers);

  put('ip',     riskToken('ip', net.ip),          true);
  put('subnet', riskToken('subnet', net.subnet),  true);
  // The ASN is expected to be absent on deployments with no IP-intelligence
  // source, so its absence is not reported as a gap — that would make every
  // request emit a warning about a feed the operator has decided not to buy.
  put('asn',    riskToken('asn', net.asn),        false);

  // ─── Only a MEANINGFUL network class is recorded ──────────────────────
  //
  // 'hosting' and 'proxy' are findings: they say something specific about
  // where the request came from, and aggregating all of them under one
  // shared token is exactly what makes a distributed botnet countable.
  //
  // 'residential' and 'unknown' are not findings, and recording them would
  // be actively harmful. Every ordinary request carries one of the two, so
  // the token would accumulate the platform's ENTIRE legitimate traffic
  // under a single key — and the class rules, which are sized for "40
  // requests from data centres in an hour", would hold every customer for
  // review the moment the platform did 40 signups in an hour. On a
  // deployment with no IP-intelligence feed at all, where every request is
  // 'unknown', that is a total outage on the first busy morning.
  //
  // So the rule skips instead, which is the honest answer: with nothing
  // known about the network, there is nothing for a network-class rule to
  // say.
  if (net.networkClass === 'hosting' || net.networkClass === 'proxy') {
    put('network_class', riskToken('network_class', net.networkClass), false);
  }

  if (!input.skipDevice) {
    put('device', riskToken('device', await resolveDeviceId()), true);
  }

  put('account',      riskToken('account', input.accountId),           !!input.accountId);
  put('identity',     riskToken('identity', input.identityHash),       !!input.identityHash);
  put('phone',        riskToken('phone', input.phone),                 !!input.phone);
  put('email',        riskToken('email', input.email),                 !!input.email);
  put('email_domain', riskToken('email_domain', input.email),          !!input.email);
  put('kyc_session',  riskToken('kyc_session', input.kycSessionRef),   !!input.kycSessionRef);
  put('card',         riskToken('card', input.cardFingerprint),        !!input.cardFingerprint);
  put('bank_account', riskToken('bank_account', input.bankAccount),    !!input.bankAccount);

  // Internal ids, unhashed. See tokens.ts for why this is the one exception.
  put('practice',       internalToken(input.practiceId),      !!input.practiceId);
  put('practice_group', internalToken(input.practiceGroupId), !!input.practiceGroupId);
  put('provider',       internalToken(input.providerId),      !!input.providerId);

  put(
    'customer_merchant',
    customerMerchantToken(input.accountId, input.practiceId),
    !!(input.accountId && input.practiceId),
  );

  return { signals, unresolved, networkClass: net.networkClass };
}
