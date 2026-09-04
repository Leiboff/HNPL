// ─── The risk vocabulary ────────────────────────────────────────────────
//
// The events, dimensions and budgets the aggregate fraud controls know
// about. This file is one half of a pair: migration 0142 declares the same
// three lists in `risk_known_event`, `risk_known_dimension` and
// `risk_known_budget`, and lib/risk/vocabulary.test.ts pins the two against
// each other.
//
// Two lists is a drift risk, accepted here for exactly the reason 0134's
// header gives for the rate-limit buckets: the whole point is that the
// DATABASE refuses an event or a dimension the application did not declare,
// and it cannot do that by reading the application. A name added on one side
// and not the other fails the suite rather than silently going unevaluated.

/** The surfaces along the loss chain that take a risk decision. */
export const RISK_EVENTS = [
  'signup',
  'checkout_initiate',
  'phone_otp',
  'kyc_session',
  'credit_check',
  'plan_acceptance',
  'card_payment',
  'payout_release',
  'counter_session',
] as const;

export type RiskEvent = (typeof RISK_EVENTS)[number];

/**
 * The correlation dimensions.
 *
 * Every one of these is an attribute a ring must rotate to stay invisible.
 * The set is chosen so that rotating any single one is not enough: a fresh
 * account still shares a device, a fresh device still shares a subnet, a
 * fresh subnet still shares a card fingerprint, and a fresh card still
 * shares the practice the money is going to.
 */
export const RISK_DIMENSIONS = [
  /** profiles.id — the weakest identifier, one signup away from a new one. */
  'account',
  /** The SA ID blind index. Two accounts sharing it is a duplicate identity. */
  'identity',
  /** Normalised E.164, tokenised. */
  'phone',
  /** Normalised address, tokenised. */
  'email',
  /** The domain alone: the disposable-mailbox cluster a ring signs up from. */
  'email_domain',
  'ip',
  /** /24 (v4) or /48 (v6) — the unit a VPN hop moves within, cheaply. */
  'subnet',
  /** The autonomous system — the unit a ring must pay to move between. */
  'asn',
  /** 'hosting' | 'proxy' | 'residential' | 'unknown', as a shared token. */
  'network_class',
  /** The first-party device cookie, tokenised. Never a hardware fingerprint. */
  'device',
  /** The KYC session / portrait signal. */
  'kyc_session',
  /** The payment-instrument fingerprint. */
  'card',
  /** A payout destination account. */
  'bank_account',
  'practice',
  'practice_group',
  'provider',
  /** The customer↔merchant edge itself, as one token. */
  'customer_merchant',
] as const;

export type RiskDimension = (typeof RISK_DIMENSIONS)[number];

/**
 * The daily platform-wide ceilings.
 *
 * The dimension no per-subject rule can cover. A ring that rotates every
 * identifier perfectly still spends OUR money at OUR vendors and issues OUR
 * credit — these are the last line that holds when the correlation rules are
 * evaded rather than tripped.
 */
export const RISK_BUDGETS = [
  'kyc',              // Didit sessions
  'sms',              // SMSPortal units
  'bureau',           // credit bureau lookups
  'payment',          // outbound card charges
  'payout',           // rands released to practices
  'approved_credit',  // rands of new credit committed
] as const;

export type RiskBudget = (typeof RISK_BUDGETS)[number];

/** The platform kill switches seeded by 0142. */
export const RISK_KILL_SWITCHES = [
  'credit_issuance',
  'vendor_spend',
  'payouts',
  'signup',
] as const;

export type RiskKillSwitch = (typeof RISK_KILL_SWITCHES)[number];

/**
 * What a decision permits, weakest first.
 *
 * `friction` is the one worth being precise about. It does NOT mean a CAPTCHA
 * in front of everybody — the audit is explicit that indiscriminate CAPTCHA
 * is not the ask. It means the caller must satisfy a step-up it already
 * offers (a phone OTP, a re-authentication, a card 3-D Secure challenge)
 * before the same request proceeds. A surface with no step-up available
 * treats friction as allow-and-flag rather than inventing one.
 */
export const RISK_ACTIONS = ['allow', 'friction', 'review', 'deny'] as const;

export type RiskAction = (typeof RISK_ACTIONS)[number];

/** Strength ordering, so "the strongest triggered action wins" is a compare. */
export const RISK_ACTION_RANK: Record<RiskAction, number> = {
  allow: 0,
  friction: 1,
  review: 2,
  deny: 3,
};

export function strongestAction(a: RiskAction, b: RiskAction): RiskAction {
  return RISK_ACTION_RANK[a] >= RISK_ACTION_RANK[b] ? a : b;
}
