// ─── Naming the alerts ──────────────────────────────────────────────────
//
// A risk decision carries its reasons as rows of {rule, metric, observed,
// threshold}. That is the right shape for a decision and the wrong shape for
// an on-call rotation: "device/accounts 4 > 3" is not something anyone can
// write a runbook entry against, and an alert nobody can route is an alert
// nobody answers.
//
// This module gives each reason a stable NAME. The names are the ones the
// audit asks for by name — merchant velocity, identity velocity, duplicate
// instrument, duplicate device, duplicate identity — so the alert, the
// runbook section and the finding all use one word for one thing.
//
// Pure and dependency-free on purpose: it is called from the decision path
// and from tests, and it must not be the reason either of them touches a
// network.

import type { RiskReason } from './evaluate';
import type { RiskEvent } from './vocabulary';

export type RiskAlertName =
  /** One identity, phone or email moving across accounts. */
  | 'identity_velocity'
  /** One practice, provider or payout destination moving abnormally. */
  | 'merchant_velocity'
  /** The same payment instrument under several accounts. */
  | 'duplicate_instrument'
  /** The same device under several accounts. */
  | 'duplicate_device'
  /** The same SA ID or KYC session under several accounts. */
  | 'duplicate_identity'
  /** One customer and one merchant transacting abnormally often. */
  | 'customer_merchant_link'
  /** Volume from one network, subnet, ASN or hosting/proxy class. */
  | 'network_velocity'
  /** A daily platform budget exhausted. */
  | 'budget_exhausted'
  /** A kill switch refused the request. */
  | 'kill_switch'
  /** A standing block — a reviewer's conclusion or a tripped breaker. */
  | 'standing_block'
  /** The decision could not be taken; the fail-closed action applied. */
  | 'control_unavailable'
  | 'other';

export type RiskAlert = {
  name: RiskAlertName;
  /** 'page' interrupts a human now; 'ticket' goes to the review queue's
   *  working hours. Severity is a property of the alert, not of the rule
   *  that produced it — a duplicate identity at 03:00 is worth waking
   *  someone for; a busy practice is not. */
  severity: 'page' | 'ticket';
  event: RiskEvent;
  reason: RiskReason;
};

const IDENTITY_DIMENSIONS = new Set(['identity', 'kyc_session']);
const MERCHANT_DIMENSIONS = new Set(['practice', 'practice_group', 'provider', 'bank_account']);
const NETWORK_DIMENSIONS  = new Set(['ip', 'subnet', 'asn', 'network_class']);

/**
 * Classify one reason.
 *
 * The `metric` matters as much as the dimension: a device seen forty times
 * by one account is network-ish volume, while a device seen by four
 * ACCOUNTS is the duplicate-device finding. Collapsing those two into one
 * alert is how a queue fills with noise and the one real link is missed.
 */
export function classifyReason(event: RiskEvent, reason: RiskReason): RiskAlert {
  const rule = String(reason.rule ?? '');
  const byAccounts = reason.metric === 'accounts';

  const name: RiskAlertName =
    rule === 'budget'                ? 'budget_exhausted'
    : rule === 'kill_switch'         ? 'kill_switch'
    : rule === 'block'               ? 'standing_block'
    : rule === 'dependency_unavailable' ? 'control_unavailable'
    : rule === 'customer_merchant'   ? 'customer_merchant_link'
    : rule === 'card'                ? (byAccounts ? 'duplicate_instrument' : 'merchant_velocity')
    : rule === 'device'              ? (byAccounts ? 'duplicate_device' : 'network_velocity')
    : IDENTITY_DIMENSIONS.has(rule)  ? (byAccounts ? 'duplicate_identity' : 'identity_velocity')
    : rule === 'phone' || rule === 'email' || rule === 'email_domain'
                                     ? 'identity_velocity'
    : MERCHANT_DIMENSIONS.has(rule)  ? 'merchant_velocity'
    : NETWORK_DIMENSIONS.has(rule)   ? 'network_velocity'
    : 'other';

  // Paging is reserved for the three things that are either unambiguous
  // evidence of a ring, or a platform-level stop that means money or vendor
  // spend has already been cut off. Everything else is a ticket — because an
  // alert that pages on a busy dental practice will be muted within a week,
  // and then the duplicate-identity page will be muted with it.
  const pages: RiskAlertName[] = [
    'duplicate_identity',
    'duplicate_instrument',
    'budget_exhausted',
    'kill_switch',
    'control_unavailable',
  ];

  return { name, severity: pages.includes(name) ? 'page' : 'ticket', event, reason };
}

/** Every alert a decision implies, de-duplicated by name. */
export function alertsFor(event: RiskEvent, reasons: RiskReason[]): RiskAlert[] {
  const seen = new Map<RiskAlertName, RiskAlert>();
  for (const reason of reasons) {
    const alert = classifyReason(event, reason);
    const existing = seen.get(alert.name);
    // Keep the more severe instance of a repeated name, so a page is never
    // downgraded by a later ticket-level reason with the same classification.
    if (!existing || (existing.severity === 'ticket' && alert.severity === 'page')) {
      seen.set(alert.name, alert);
    }
  }
  return [...seen.values()];
}
