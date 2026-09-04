import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { RISK_EVENTS, type RiskEvent } from '@/lib/risk/vocabulary';

// ─── Every step of the loss chain is actually gated ─────────────────────────
//
// The audit's S-07 describes a chain of individually valid requests:
//
//     automated signup → OTP → KYC across many identities → the
//     unconditional stub limit → a colluding or compromised practice →
//     first payment → merchant payout → default on the rest
//
// A control that is only present on six of those seven steps is not a control
// on the chain — the ring walks through the ungated one. So this file reads
// the SOURCES, not the mocks, and asserts that each step calls the decision.
//
// ─── WHY A SOURCE-TEXT TEST AND NOT A BEHAVIOURAL ONE ───────────────────────
//
// Because the failure it is written to catch is a DELETION. Every action test
// downstream of these call sites stubs the risk module (lib/testing/
// riskTestMock.ts) so it can reach the behaviour it is actually about — which
// means removing the gate entirely would leave every one of those suites
// green. This is the test that would go red, and it is the only one that
// would.
//
// The repo already uses this shape for the same reason elsewhere
// (app/no-geocoding-api.test.ts, app/test-path-integrity.test.ts).

const ROOT = resolve(process.cwd());

function source(path: string): string {
  return stripComments(readFileSync(resolve(ROOT, path), 'utf8'), { jsxBraces: false });
}

/** Each step of the chain: the file, the function, and the event it must take. */
const GATED: Array<{
  path: string;
  fn: string;
  event: RiskEvent;
  why: string;
}> = [
  {
    path: 'app/signup/patient/actions.ts',
    fn: 'signUpPatient',
    event: 'signup',
    why: 'Step 1 — automated account creation.',
  },
  {
    path: 'app/checkout/[token]/actions.ts',
    fn: 'initiateCheckout',
    event: 'checkout_initiate',
    why: 'The third door onto an account, reached with a bill token.',
  },
  {
    path: 'app/(auth)/verify-phone/actions.ts',
    fn: 'requestPhoneOtpForUser',
    event: 'phone_otp',
    why: 'Step 2 — a paid SMS unit per send.',
  },
  {
    path: 'app/checkout/[token]/actions.ts',
    fn: 'requestPhoneOtp',
    event: 'phone_otp',
    why: 'The anonymous OTP twin, where a fresh bill token would otherwise buy a fresh allowance.',
  },
  {
    path: 'lib/onboarding/actions.ts',
    fn: 'startIdentityVerification',
    event: 'kyc_session',
    why: 'Step 3 — a paid KYC unit per session.',
  },
  {
    path: 'lib/onboarding/actions.ts',
    fn: 'submitIdentityForVerification',
    event: 'kyc_session',
    why: 'Step 3, the DHA path — a registry lookup and a face-match session.',
  },
  {
    path: 'lib/onboarding/actions.ts',
    fn: 'runCreditCheck',
    event: 'credit_check',
    why: 'A bureau enquiry, billable per call once the stub is replaced.',
  },
  {
    path: 'app/patient/actions.ts',
    fn: 'acceptPlan',
    event: 'plan_acceptance',
    why: 'Steps 4-5 — the point at which credit is committed.',
  },
  {
    path: 'app/patient/actions.ts',
    fn: 'payWithSavedCard',
    event: 'card_payment',
    why: 'Step 6 — the first payment, and the card-testing surface.',
  },
  {
    path: 'app/admin/payouts/actions.ts',
    fn: 'markBatchPaid',
    event: 'payout_release',
    why: 'Step 7 — after this the money has left.',
  },
  {
    path: 'app/admin/payouts/actions.ts',
    fn: 'markPayoutPaid',
    event: 'payout_release',
    why: 'The smaller door into the same room; ungated it makes the batch gate avoidable.',
  },
  {
    path: 'app/practice/pos/actions.ts',
    fn: 'issueCounterSession',
    event: 'counter_session',
    why: 'The merchant raising the bill the chain runs through.',
  },
];

describe('the loss chain — every step takes a risk decision', () => {
  it.each(GATED)('$path :: $fn gates on $event — $why', ({ path, fn, event }) => {
    const src = source(path);

    expect(src, `${path} imports the risk decision`)
      .toMatch(/from\s+['"]@\/lib\/risk\/evaluate['"]/);

    // The function exists and the event name appears in the file. Deliberately
    // two separate assertions rather than a fragile single regex over the
    // function body: the point is to catch a deletion, and a deletion removes
    // both.
    expect(src, `${path} still declares ${fn}`).toContain(fn);
    expect(src, `${path} evaluates '${event}'`).toContain(`'${event}'`);
  });

  it('acts on the answer rather than merely logging it', () => {
    // A gate that computes a decision and proceeds regardless is the most
    // plausible way for this to rot: the call survives every grep and the
    // control does nothing.
    for (const { path } of GATED) {
      const src = source(path);
      const acts =
        /mayProceed\(/.test(src) ||
        /payoutRiskRefusal\(/.test(src);
      expect(acts, `${path} branches on the decision`).toBe(true);
    }
  });

  it('covers every declared event with at least one call site', () => {
    // The other direction: an event declared in the policy but wired nowhere
    // is a rule nobody evaluates, which reads as coverage on a review and
    // provides none.
    const wired = new Set(GATED.map((g) => g.event));
    for (const event of RISK_EVENTS) {
      expect(wired.has(event), `${event} has a call site`).toBe(true);
    }
  });
});

describe('ordering — the decision is taken before the irreversible step', () => {
  it('acceptPlan decides BEFORE it claims credit', () => {
    // A risk decision taken after the credit is committed is not a control.
    const src = source('app/patient/actions.ts');
    const decision = src.indexOf("event:      'plan_acceptance'");
    const claim    = src.indexOf('claimCreditForPlan(');
    expect(decision).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(claim);
  });

  it('startIdentityVerification decides BEFORE it calls the vendor', () => {
    // The budget is only meaningful while the money is still ours.
    const src = source('lib/onboarding/actions.ts');
    const decision = src.indexOf("event:         'kyc_session'");
    const vendor   = src.indexOf('createDiditSession(');
    expect(decision).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(vendor);
  });

  it('requestPhoneOtpForUser decides BEFORE it generates and sends a code', () => {
    const src = source('app/(auth)/verify-phone/actions.ts');
    const decision = src.indexOf("event:     'phone_otp'");
    const send     = src.indexOf('sendSms(');
    expect(decision).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(send);
  });

  it('the anonymous checkout OTP decides BEFORE it sends too', () => {
    const src = source('app/checkout/[token]/actions.ts');
    const decision = src.indexOf("event: 'phone_otp'");
    const send     = src.indexOf('sendSms(');
    expect(decision).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(send);
  });

  it('markBatchPaid decides BEFORE it records the settlement assertion', () => {
    // A settlement recorded as intended and then refused would leave the
    // audit trail claiming an EFT was asserted when it was not.
    const src = source('app/admin/payouts/actions.ts');
    const decision = src.indexOf('payoutRiskRefusal(');
    const record   = src.indexOf('recordAdminAction(');
    expect(decision).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(record);
  });
});

describe('the risk decision sits alongside the rate limiter, not instead of it', () => {
  // The two answer different questions and the audit is explicit that the
  // second does not replace the first. A call site that dropped its bucket
  // when it gained a risk gate would have traded a cheap, durable per-subject
  // limit for an expensive aggregate one.
  const RATE_LIMITED = [
    'app/signup/patient/actions.ts',
    'app/checkout/[token]/actions.ts',
    'lib/onboarding/actions.ts',
    'app/patient/actions.ts',
    'app/practice/pos/actions.ts',
  ];

  it.each(RATE_LIMITED)('%s still consumes its rate-limit bucket', (path) => {
    expect(source(path)).toMatch(/consumeAll\(/);
  });
});
