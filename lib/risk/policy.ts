// ─── The risk policy ────────────────────────────────────────────────────
//
// Every threshold in the aggregate fraud controls, in one table so they can
// be reviewed as a SET rather than discovered one call site at a time. Same
// argument lib/security/rateLimit.ts makes for RATE_LIMITS, and it matters
// more here: a velocity rule is only meaningful relative to the other rules
// on the same surface, because an attacker picks whichever dimension is
// loosest.
//
// ─── HOW A RULE IS SIZED ────────────────────────────────────────────────
//
// Against the LEGITIMATE repeat profile of that dimension on that surface,
// never against a round number, and then with headroom. Two questions,
// asked in this order:
//
//   1. What does the busiest honest case look like? A dental practice's
//      front desk on a Monday. A family of four on one home router. A
//      corporate NAT in a call centre. A patient whose card declines twice.
//   2. What does the cheapest dishonest case look like? A script that
//      rotates accounts but not devices, because rotating devices means
//      discarding cookies and re-solving every step-up.
//
// A rule earns its place only when those two answers are far apart. Where
// they are close — and they ARE close for IP on a mobile network, where one
// carrier NAT can front a whole city — the rule is set to `review` rather
// than `deny`, so the failure mode is a human looking at a queue rather than
// a customer being told no.
//
// ─── WHY max_accounts IS THE IMPORTANT NUMBER ───────────────────────────
//
// `max_events` is a rate limit with extra steps; the existing per-operation
// buckets already do that job well. `max_accounts` is the one thing no
// per-operation limit can express: how many DISTINCT accounts share this
// device, this card, this identity, this payout destination. That count is
// what a ring cannot keep at one without paying for genuinely separate
// infrastructure per identity, which is the cost this whole exercise exists
// to impose.
//
// ─── ON FAILING CLOSED ──────────────────────────────────────────────────
//
// Every event refuses when the decision cannot be taken (`onUnavailable`),
// and that is a change of posture from 0124's original fail-open rate
// limiter — but not from where the codebase actually is: lib/security/
// rateLimit.ts already fails closed on exactly these surfaces, so a database
// outage refuses signup and checkout today regardless of this file. Matching
// it keeps one behaviour under one failure instead of two.
//
// The audit asks for "safe fail-closed behavior without locking out normal
// household/shared-network patterns". Those are different failures: the
// first is our dependency being down, the second is our thresholds being
// wrong. The first is answered here; the second is answered by keying on
// several dimensions at once and by preferring `review` to `deny` on the
// shared-infrastructure dimensions.

import type {
  RiskAction,
  RiskBudget,
  RiskDimension,
  RiskEvent,
  RiskKillSwitch,
} from './vocabulary';

export type RiskRule = {
  dimension: RiskDimension;
  windowSecs: number;
  /** Refuse above this many observations of the token in the window. */
  maxEvents?: number;
  /** Refuse above this many DISTINCT accounts sharing the token. */
  maxAccounts?: number;
  action: RiskAction;
  /** Why this number. Carried into the alert so an operator tuning a
   *  threshold at 03:00 does not have to reconstruct the reasoning. */
  rationale: string;
};

export type RiskBudgetSpend = {
  budget: RiskBudget;
  /** Units per call. `'amount'` spends the transaction's own rand value —
   *  the only sane unit for payout and approved-credit ceilings. */
  units: number | 'amount';
};

export type RiskEventPolicy = {
  rules: RiskRule[];
  budgets: RiskBudgetSpend[];
  /** Which kill switches stop THIS event. Engaging 'payouts' must not stop
   *  a patient paying their instalment. */
  switches: RiskKillSwitch[];
  /** The decision when the risk RPC cannot be reached at all. */
  onUnavailable: RiskAction;
  /**
   * Step-ups this surface can actually demand. Empty means a `friction`
   * decision degrades to allow-and-alert rather than inventing a challenge —
   * which is the audit's point about not reaching for indiscriminate CAPTCHA.
   */
  stepUps: Array<'phone_otp' | 'reauth' | 'kyc' | 'manual_contact'>;
};

// ─── Daily platform budgets ─────────────────────────────────────────────
//
// Deliberately readable from the environment so an operator can lower a
// ceiling during an incident without a deploy — the same reason the kill
// switches live in a table. The defaults below are sized for a launch-scale
// deployment and are meant to be revisited against real volume; they are
// generous enough not to bite ordinary traffic and small enough that a ring
// running flat out hits one within hours rather than weeks.
//
// The two rand-denominated ones are the ones that matter most. `payout` and
// `approved_credit` are the only ceilings expressed in the currency of the
// actual loss, and they are the last thing standing if every correlation
// rule is evaded rather than tripped.

const BUDGET_DEFAULTS: Record<RiskBudget, number> = {
  kyc:             500,        // paid Didit sessions
  sms:            2_000,       // SMSPortal units
  bureau:          500,        // paid bureau lookups
  payment:        5_000,       // outbound card charges
  // Rands released to practices. Sized against a WEEK of accrual, not a day,
  // because payouts are batched weekly (lib/payments/runPayoutBatches.ts) and
  // the whole week settles on batch day. A ceiling set to a day's worth would
  // not be a fraud control, it would be a Thursday outage: roughly
  // approved_credit x 0.94 x 7 is what one batch day legitimately releases,
  // and this sits just above it.
  payout:       1_800_000,
  // Rands of NEW credit committed. The only ceiling expressed in the currency
  // of the actual loss, and the last thing standing if every correlation rule
  // is evaded rather than tripped.
  approved_credit: 250_000,
};

const BUDGET_ENV: Record<RiskBudget, string> = {
  kyc:             'RISK_DAILY_BUDGET_KYC',
  sms:             'RISK_DAILY_BUDGET_SMS',
  bureau:          'RISK_DAILY_BUDGET_BUREAU',
  payment:         'RISK_DAILY_BUDGET_PAYMENT',
  payout:          'RISK_DAILY_BUDGET_PAYOUT',
  approved_credit: 'RISK_DAILY_BUDGET_APPROVED_CREDIT',
};

/**
 * The ceiling for one budget.
 *
 * A malformed or negative override falls back to the default rather than to
 * zero: a typo in an environment variable must not become a platform-wide
 * outage, and it must not become an unlimited budget either.
 */
export function dailyBudgetLimit(budget: RiskBudget): number {
  const raw = process.env[BUDGET_ENV[budget]];
  if (raw === undefined) return BUDGET_DEFAULTS[budget];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return BUDGET_DEFAULTS[budget];
  return parsed;
}

// ─── The rules, per event ───────────────────────────────────────────────

const HOUR = 3_600;
const DAY  = 86_400;
const WEEK = 604_800;
const MONTH = 2_592_000;

export const RISK_POLICY: Record<RiskEvent, RiskEventPolicy> = {
  // ── Step 1 of the loss chain: automate signup ────────────────────────
  //
  // No step-up exists here — there is no account yet to challenge. So the
  // rules are set to `review` and `deny` only; a `friction` action on this
  // surface would be a decision nothing can act on.
  signup: {
    rules: [
      { dimension: 'device', windowSecs: WEEK, maxAccounts: 3, action: 'review',
        rationale: 'A shared family laptop reaches three accounts; a script that does not clear cookies between identities reaches thirty.' },
      { dimension: 'device', windowSecs: DAY, maxEvents: 15, action: 'review',
        rationale: 'Fifteen signup attempts from one browser in a day is not a person fumbling a password.' },
      { dimension: 'subnet', windowSecs: HOUR, maxEvents: 30, action: 'review',
        rationale: 'A /24 is roughly one customer allocation. Thirty new accounts an hour from one is a campaign, not a household.' },
      { dimension: 'asn', windowSecs: HOUR, maxEvents: 400, action: 'review',
        rationale: 'Deliberately loose: a single mobile carrier NAT fronts an entire city. This catches a hosting provider, not Vodacom.' },
      { dimension: 'network_class', windowSecs: HOUR, maxEvents: 40, action: 'review',
        rationale: 'A shared token across ALL hosting/proxy traffic. Ordinary customers do not sign up from data centres; forty an hour is a botnet.' },
      { dimension: 'email_domain', windowSecs: HOUR, maxEvents: 80, action: 'review',
        rationale: 'An HOUR, not a day, because that is what separates the two cases: a mailbox farm concentrates eighty accounts from one throwaway domain into one sitting, while gmail.com spreads its share of a day\'s signups across all of it. A daily threshold low enough to catch the farm would hold every Gmail customer on the first busy day.' },
    ],
    budgets: [],
    switches: ['signup'],
    onUnavailable: 'deny',
    stepUps: [],
  },

  // ── The anonymous bill-token door, which also creates auth users ─────
  checkout_initiate: {
    rules: [
      { dimension: 'device', windowSecs: DAY, maxAccounts: 3, action: 'review',
        rationale: 'Same reasoning as signup: this surface creates accounts too, and a reception desk tablet is the one honest multi-account case.' },
      { dimension: 'subnet', windowSecs: HOUR, maxEvents: 40, action: 'review',
        rationale: 'A busy practice fronts many patients from one network, so this sits above signup rather than at it.' },
      { dimension: 'practice', windowSecs: HOUR, maxEvents: 150, action: 'review',
        rationale: 'The merchant side of the door. A practice converting 150 bill tokens an hour is either very large or manufacturing customers.' },
      { dimension: 'network_class', windowSecs: HOUR, maxEvents: 40, action: 'review',
        rationale: 'As signup. A patient scanning a QR code at a counter is not on a hosting network.' },
    ],
    budgets: [],
    switches: ['signup'],
    onUnavailable: 'deny',
    stepUps: [],
  },

  // ── Step 2: OTP. Real money at a vendor, per send ────────────────────
  phone_otp: {
    rules: [
      { dimension: 'phone', windowSecs: DAY, maxAccounts: 2, action: 'deny',
        rationale: 'One number belongs to one person. Two tolerates a genuine account migration; the third is the pattern the 2026-09-02 audit describes for planted verification rows.' },
      { dimension: 'device', windowSecs: DAY, maxAccounts: 4, action: 'review',
        rationale: 'Above the signup threshold because a household shares a device AND legitimately verifies several numbers on it.' },
      { dimension: 'subnet', windowSecs: HOUR, maxEvents: 60, action: 'review',
        rationale: 'Sixty SMS units an hour to one /24 is a cost attack whoever is behind it.' },
    ],
    budgets: [{ budget: 'sms', units: 1 }],
    switches: ['vendor_spend'],
    onUnavailable: 'deny',
    stepUps: [],
  },

  // ── Step 3: KYC across multiple identities. A PAID unit per call ─────
  kyc_session: {
    rules: [
      // The duplicate-identity control the audit asks for by name. The 0097
      // unique index already stops one SA ID reaching two profiles; this
      // catches the attempt BEFORE a paid vendor session is spent on it, and
      // catches the pending-hash path 0103 deliberately left unconstrained.
      { dimension: 'identity', windowSecs: MONTH, maxAccounts: 1, action: 'deny',
        rationale: 'One SA ID is one person. A second account presenting it is a duplicate identity by definition, not a threshold judgement.' },
      { dimension: 'device', windowSecs: WEEK, maxAccounts: 3, action: 'review',
        rationale: 'Three verified identities from one browser in a week is a family helping each other; the fourth is a ring working through a list.' },
      { dimension: 'kyc_session', windowSecs: MONTH, maxAccounts: 1, action: 'review',
        rationale: 'The same verification session or portrait signal appearing under a second account is either a replay or the same face twice.' },
      { dimension: 'ip', windowSecs: DAY, maxEvents: 20, action: 'review',
        rationale: 'Twenty paid KYC sessions a day from one address. The per-IP bucket already caps this at 10; the rule exists so the aggregate is visible when the IP rotates and the device does not.' },
      { dimension: 'network_class', windowSecs: DAY, maxEvents: 60, action: 'review',
        rationale: 'Aggregate paid-vendor spend from hosting networks, whatever addresses it arrives on.' },
    ],
    budgets: [{ budget: 'kyc', units: 1 }],
    switches: ['vendor_spend'],
    onUnavailable: 'deny',
    stepUps: [],
  },

  // ── A paid bureau call ───────────────────────────────────────────────
  credit_check: {
    rules: [
      { dimension: 'identity', windowSecs: MONTH, maxAccounts: 1, action: 'deny',
        rationale: 'As kyc_session. A bureau lookup under a second account for one identity is the synthetic-identity pattern.' },
      { dimension: 'device', windowSecs: WEEK, maxAccounts: 3, action: 'review',
        rationale: 'Matches the KYC threshold: the same person is walking through both steps.' },
      { dimension: 'network_class', windowSecs: DAY, maxEvents: 60, action: 'review',
        rationale: 'Aggregate paid-vendor spend from hosting networks.' },
    ],
    budgets: [{ budget: 'bureau', units: 1 }],
    switches: ['vendor_spend'],
    onUnavailable: 'deny',
    stepUps: [],
  },

  // ── Steps 4-6: the colluding practice, and credit being committed ────
  //
  // The densest policy in the file, because this is the point of loss. Every
  // preceding step costs the attacker a little; this one hands them money.
  plan_acceptance: {
    rules: [
      { dimension: 'identity', windowSecs: MONTH, maxAccounts: 1, action: 'deny',
        rationale: 'One identity, one borrower. Enforced here as well as at KYC because an account can reach acceptance by a path that skipped a session.' },
      { dimension: 'device', windowSecs: WEEK, maxAccounts: 3, action: 'review',
        rationale: 'Three borrowers on one device in a week is a household. The fourth taking credit is the ring signature.' },
      // The instrument dimension. A ring's hardest cost is genuinely
      // distinct payment instruments, so this is the tightest link rule.
      { dimension: 'card', windowSecs: MONTH, maxAccounts: 2, action: 'review',
        rationale: 'A couple sharing one card is real and common; four identities on one card is not.' },
      { dimension: 'card', windowSecs: DAY, maxEvents: 6, action: 'review',
        rationale: 'Six plans against one instrument in a day, whoever holds it.' },
      // The merchant side. `bank_account` here is the practice's payout
      // destination, so distinct accounts on it counts DISTINCT BORROWERS
      // funnelling to one bank account — including two practices that share
      // one, which is the shell-branch pattern.
      { dimension: 'bank_account', windowSecs: WEEK, maxEvents: 400, action: 'review',
        rationale: 'Volume through ONE destination account across every practice that settles into it — the shell-branch pattern, where five registrations share one bank account. Counted as events rather than distinct borrowers on purpose: a single large practice legitimately has hundreds of borrowers a week, and holding it would stop real patients at a real counter. The sharper per-practice judgement is the nightly circuit breaker, which a human reviews.' },
      { dimension: 'customer_merchant', windowSecs: DAY, maxEvents: 3, action: 'review',
        rationale: 'One customer taking a third plan at the same practice on the same day. Legitimate treatment is not billed this way.' },
      { dimension: 'practice', windowSecs: DAY, maxEvents: 120, action: 'review',
        rationale: 'Plan acceptances at one practice in a day. Above counter_session because acceptance is the subset that converted.' },
      { dimension: 'subnet', windowSecs: DAY, maxEvents: 25, action: 'review',
        rationale: 'Twenty-five acceptances from one /24 in a day.' },
    ],
    // The rand ceiling on new credit. This is the number that bounds a
    // single day's loss when every rule above has been evaded.
    budgets: [{ budget: 'approved_credit', units: 'amount' }],
    switches: ['credit_issuance'],
    onUnavailable: 'deny',
    stepUps: ['phone_otp', 'reauth'],
  },

  // ── Step 6: the first payment ────────────────────────────────────────
  card_payment: {
    rules: [
      { dimension: 'card', windowSecs: HOUR, maxEvents: 12, action: 'deny',
        rationale: 'Twelve charge attempts on one instrument in an hour is card testing, not a customer retrying a declined payment.' },
      { dimension: 'card', windowSecs: MONTH, maxAccounts: 3, action: 'review',
        rationale: 'Looser than plan_acceptance: paying someone else\'s instalment from your card is a thing families do.' },
      { dimension: 'device', windowSecs: DAY, maxEvents: 30, action: 'review',
        rationale: 'Blast radius on a compromised session or a looping client.' },
    ],
    budgets: [{ budget: 'payment', units: 1 }],
    switches: [],
    onUnavailable: 'deny',
    stepUps: ['reauth'],
  },

  // ── Step 7: the merchant payout ──────────────────────────────────────
  //
  // The last point at which money can be held. Everything before this is
  // recoverable in principle; after it the funds have left.
  payout_release: {
    rules: [
      { dimension: 'practice', windowSecs: DAY, maxEvents: 3, action: 'review',
        rationale: 'Payouts are batched weekly. A practice being released more than three times in a day means something is re-running.' },
      { dimension: 'bank_account', windowSecs: WEEK, maxEvents: 8, action: 'review',
        rationale: 'One destination account receiving eight releases a week: several practices paying into it, which is the shell-branch pattern.' },
    ],
    budgets: [{ budget: 'payout', units: 'amount' }],
    switches: ['payouts'],
    onUnavailable: 'deny',
    stepUps: ['manual_contact'],
  },

  // ── The merchant raising a bill ──────────────────────────────────────
  counter_session: {
    rules: [
      { dimension: 'practice', windowSecs: HOUR, maxEvents: 250, action: 'review',
        rationale: 'Above the existing per-practice bucket of 200/hour so this fires as a fraud signal, not as a duplicate of the rate limit.' },
      { dimension: 'practice', windowSecs: DAY, maxAccounts: 150, action: 'review',
        rationale: 'A hundred and fifty distinct patients billed by one practice in a day. Set well above a large clinic rather than at it: holding this rule stops a real front desk from raising real bills, and the merchant judgement that needs a finer threshold is the nightly circuit breaker, where a human decides.' },
      { dimension: 'provider', windowSecs: DAY, maxEvents: 200, action: 'review',
        rationale: 'One clinician attached to two hundred bills in a day is a credential being used as a rubber stamp.' },
    ],
    budgets: [],
    switches: [],
    onUnavailable: 'deny',
    stepUps: [],
  },
};

/** The wire shape 0142's `evaluate_risk` expects for its `p_rules`. */
export function rulesForRpc(event: RiskEvent): Array<Record<string, unknown>> {
  return RISK_POLICY[event].rules.map((rule) => ({
    dimension:   rule.dimension,
    window_secs: rule.windowSecs,
    ...(rule.maxEvents   !== undefined ? { max_events:   rule.maxEvents }   : {}),
    ...(rule.maxAccounts !== undefined ? { max_accounts: rule.maxAccounts } : {}),
    action: rule.action,
  }));
}

/** The wire shape for `p_budgets`, with `'amount'` resolved against the
 *  transaction value. A zero or missing amount spends nothing — a payout of
 *  R0 should not consume the day's payout ceiling. */
export function budgetsForRpc(
  event: RiskEvent,
  amount: number,
): Array<Record<string, unknown>> {
  return RISK_POLICY[event].budgets.map((spend) => ({
    budget: spend.budget,
    units:  spend.units === 'amount' ? Math.max(0, amount) : spend.units,
    limit:  dailyBudgetLimit(spend.budget),
  }));
}
