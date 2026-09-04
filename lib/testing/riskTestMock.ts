import type { RiskDecision } from '@/lib/risk/evaluate';

// ─── Shared fixture for action tests downstream of the risk decision ────────
//
// The twin of `allowTestRateLimit`, and here for the same reason its own
// header gives: an action test whose subject is business behaviour should not
// have to emulate the aggregate fraud controls to reach the code it is about.
//
// This matters more here than it did for the limiter, because the risk
// decision FAILS CLOSED. An unmocked action test does not merely skip the
// evaluation — it gets `deny`, and every assertion downstream fails with a
// refusal message instead of the behaviour under test. That is correct
// production behaviour and useless test behaviour.
//
// The controls' own suites (lib/risk/*.test.ts and
// supabase/migrations/0142_fraud_risk_controls.rpc.test.ts) exercise
// tokenisation, the velocity rules, budgets, kill switches, review
// transitions, retention and the fail-closed path. Nothing is lost by
// stubbing them here; what IS pinned separately is that each call site still
// CALLS them — see app/risk-wiring.test.ts, which reads the sources rather
// than the mocks.

export const ALLOW_RISK: RiskDecision = {
  decision: 'allow',
  allowed: true,
  score: 0,
  reasons: [],
  outcome: 'evaluated',
  eventId: null,
  reviewId: null,
  stepUps: [],
  refusalMessage: null,
};

/** Spread into a `vi.mock('@/lib/risk/evaluate', …)` factory. */
export const allowTestRisk = {
  evaluateRisk: async (): Promise<RiskDecision> => ALLOW_RISK,
  mayProceed: () => true,
  refusalMessageFor: () => null,
  RISK_RPC_TIMEOUT_MS: 3_000,
};

/**
 * The refusing counterpart, for the handful of tests that assert a call site
 * actually honours a refusal rather than logging it and carrying on.
 */
export function refuseTestRisk(decision: 'review' | 'deny' = 'deny') {
  const refused: RiskDecision = {
    ...ALLOW_RISK,
    decision,
    allowed: false,
    score: 100,
    reasons: [{ rule: 'test', action: decision }],
    refusalMessage: 'refused by the risk controls',
  };
  return {
    evaluateRisk: async (): Promise<RiskDecision> => refused,
    mayProceed: () => false,
    refusalMessageFor: () => refused.refusalMessage,
    RISK_RPC_TIMEOUT_MS: 3_000,
  };
}
