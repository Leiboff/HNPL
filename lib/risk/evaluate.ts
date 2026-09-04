// ─── The one risk-decision call site ────────────────────────────────────
//
// Deliberately shaped like lib/security/rateLimit.ts's `consumeAll`, because
// it sits beside it at every call site and the two should not need different
// habits: one await, one boolean-ish answer, structured telemetry on every
// refusal, fail closed on a dependency failure.
//
// What differs is what it answers. `consumeAll` answers "has this ONE
// subject spent its budget". This answers "given everything we know about
// this request — the identity behind it, the device it came from, the
// network it crossed, the instrument it will charge, the merchant it will
// pay — should it proceed, and if not, why". The audit's point is that the
// first question cannot be asked enough times to add up to the second.
//
// ─── ONE ROUND TRIP, NOT N ──────────────────────────────────────────────
//
// Every rule is evaluated inside migration 0142's `evaluate_risk`, under
// advisory locks on the supplied tokens. Assembling the same decision from
// several reads here would be a check-then-act — the shape audit A-04
// already caught once in this codebase — and would let two concurrent
// members of the same ring each see the pre-write counts and each proceed.
//
// ─── FAIL CLOSED ────────────────────────────────────────────────────────
//
// A dependency failure returns the event's `onUnavailable` action, which is
// `deny` for every event in the policy. This matches lib/security/
// rateLimit.ts, which already fails closed on the same surfaces — so a
// database outage refuses signup today whether or not this module exists,
// and having the two disagree would produce a system whose behaviour under
// failure nobody can state.
//
// ─── WHAT THE CALLER MUST DO WITH THE ANSWER ────────────────────────────
//
//   allow     proceed
//   friction  proceed only after a step-up the surface already offers. A
//             surface with none (`stepUps: []`) treats this as proceed, and
//             the alert is the product. This is the audit's "risk-triggered
//             friction rather than indiscriminate CAPTCHA" — no challenge is
//             invented for a surface that has none to give.
//   review    do not proceed. A queue row exists; tell the person their
//             application is being checked, not that they were refused.
//   deny      refuse.
//
// `refusalMessage` gives the copy for the last two, so the decision and the
// sentence shown to the person cannot drift apart across nine call sites.

import { createClient as createServiceClient } from '@supabase/supabase-js';
import { collectRiskSignals, type RiskSignalInput } from './signals';
import { budgetsForRpc, RISK_POLICY, rulesForRpc } from './policy';
import { RiskKeyUnavailableError } from './tokens';
import type { RiskAction, RiskEvent } from './vocabulary';

/** Shorter than any calling action's own timeout, as the rate limiter's is. */
export const RISK_RPC_TIMEOUT_MS = 3_000;

export type RiskReason = {
  rule: string;
  metric?: string;
  observed?: number;
  threshold?: number;
  window_secs?: number;
  action?: string;
  [key: string]: unknown;
};

export type RiskOutcome = 'evaluated' | 'unavailable' | 'unknown_event';

export type RiskDecision = {
  decision: RiskAction;
  /** True only for `allow`. The shorthand most call sites want. */
  allowed: boolean;
  score: number;
  reasons: RiskReason[];
  outcome: RiskOutcome;
  eventId: string | null;
  reviewId: string | null;
  /** Step-ups this surface can demand, when the decision is `friction`. */
  stepUps: RiskEventPolicyStepUps;
  /** Copy for the person in front of the screen, on review/deny. */
  refusalMessage: string | null;
};

type RiskEventPolicyStepUps = (typeof RISK_POLICY)[RiskEvent]['stepUps'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

function svc(): Svc {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

class RiskRpcTimeoutError extends Error {
  constructor() {
    super('risk RPC timed out');
    this.name = 'RiskRpcTimeoutError';
  }
}

async function withTimeout<T>(operation: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RiskRpcTimeoutError()), RISK_RPC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── The copy ───────────────────────────────────────────────────────────
//
// Two sentences, and the distinction between them is not cosmetic.
//
// A `review` is not a refusal, so it must not read as one — the person may
// well be a customer whose household shares a router with three relatives,
// and telling them they were rejected for fraud is both wrong and a support
// call. A `deny` is a refusal and says so, without explaining which rule
// fired: a refusal that names its threshold is a tuning oracle.

const REVIEW_MESSAGE =
  "We need to check a few details before we can continue. Our team will be in touch shortly — you don't need to do anything right now.";

const DENY_MESSAGE =
  "We can't continue with this request right now. If you think this is a mistake, contact support and we'll take a look.";

export function refusalMessageFor(decision: RiskAction): string | null {
  if (decision === 'review') return REVIEW_MESSAGE;
  if (decision === 'deny')   return DENY_MESSAGE;
  return null;
}

// ─── Telemetry ──────────────────────────────────────────────────────────
//
// One JSON line per non-allow decision, on the shape rateLimit.ts's
// `rate_limit_decision` established so both can be consumed by one parser.
// Allowed traffic is not logged: it is the overwhelming majority and its
// durable record is risk_observations.
//
// No token appears in the line. A log that carries correlation tokens
// re-creates, in the log aggregator, the joinable store that lib/risk/
// tokens.ts exists to avoid — with none of the retention controls.

function emit(input: {
  event: RiskEvent;
  decision: RiskAction;
  outcome: RiskOutcome;
  score: number;
  reasons: RiskReason[];
  unresolved: string[];
  networkClass: string;
  reviewId: string | null;
  dependencyStage?: 'client_init' | 'rpc' | 'rpc_timeout' | 'key';
  dependencyCode?: string;
}): void {
  const line = JSON.stringify({
    event: 'risk_decision',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    risk_event: input.event,
    decision: input.decision,
    outcome: input.outcome,
    score: input.score,
    // The rule names and numbers, never the subject.
    reasons: input.reasons.map((r) => ({
      rule: r.rule, metric: r.metric,
      observed: r.observed, threshold: r.threshold,
      window_secs: r.window_secs, action: r.action,
    })),
    unresolved_signals: input.unresolved,
    network_class: input.networkClass,
    review_id: input.reviewId,
    ...(input.dependencyStage ? { dependency_stage: input.dependencyStage } : {}),
    ...(input.dependencyCode ? { dependency_code: input.dependencyCode.slice(0, 64) } : {}),
  });
  if (input.outcome === 'unavailable' || input.decision === 'deny') console.error(line);
  else console.warn(line);
}

export type EvaluateRiskInput = RiskSignalInput & {
  event: RiskEvent;
  /** Rands. Spent against the rand-denominated budgets (payout, approved
   *  credit) and recorded on the observation so exposure can be summed. */
  amount?: number;
  /** Injection seam for tests, matching consumeRateLimit's. */
  client?: Svc;
};

function unavailable(
  event: RiskEvent,
  stage: 'client_init' | 'rpc' | 'rpc_timeout' | 'key',
  code: string,
  networkClass = 'unknown',
  unresolvedSignals: string[] = [],
): RiskDecision {
  const decision = RISK_POLICY[event].onUnavailable;
  emit({
    event, decision, outcome: 'unavailable', score: 0,
    reasons: [{ rule: 'dependency_unavailable', action: decision }],
    unresolved: unresolvedSignals, networkClass, reviewId: null,
    dependencyStage: stage, dependencyCode: code,
  });
  return {
    decision,
    allowed: decision === 'allow',
    score: 0,
    reasons: [{ rule: 'dependency_unavailable', action: decision }],
    outcome: 'unavailable',
    eventId: null,
    reviewId: null,
    stepUps: RISK_POLICY[event].stepUps,
    refusalMessage: refusalMessageFor(decision),
  };
}

/**
 * Take the aggregate risk decision for one request.
 *
 * Never throws: every failure path returns the event's fail-closed action
 * with an alertable telemetry line. A control that can throw is a control
 * that takes the surface down with it.
 */
export async function evaluateRisk(input: EvaluateRiskInput): Promise<RiskDecision> {
  const { event, amount = 0, client, ...signalInput } = input;
  const policy = RISK_POLICY[event];

  let collected;
  try {
    collected = await collectRiskSignals(signalInput);
  } catch (err) {
    // A missing correlation key lands here. Failing closed is the whole
    // point: a keyless deployment must refuse the surface rather than run
    // with the fraud controls silently disabled. See tokens.ts.
    return unavailable(
      event,
      err instanceof RiskKeyUnavailableError ? 'key' : 'client_init',
      err instanceof Error ? err.name : 'UnknownError',
    );
  }

  let db: Svc;
  try {
    db = client ?? svc();
  } catch (err) {
    return unavailable(
      event, 'client_init', err instanceof Error ? err.name : 'UnknownError',
      collected.networkClass, collected.unresolved,
    );
  }

  let payload: {
    ok?: boolean;
    decision?: RiskAction;
    score?: number;
    reasons?: RiskReason[];
    event_id?: string | null;
    review_id?: string | null;
  } | null;

  try {
    const operation = db.rpc('evaluate_risk', {
      p_event:       event,
      p_account_id:  input.accountId ?? null,
      p_practice_id: input.practiceId ?? null,
      p_signals:     collected.signals,
      p_rules:       rulesForRpc(event),
      p_budgets:     budgetsForRpc(event, amount),
      p_switches:    policy.switches,
      p_amount:      amount,
    }) as PromiseLike<{ data: typeof payload; error: { code?: string } | null }>;

    const { data, error } = await withTimeout(operation);
    if (error) {
      return unavailable(
        event, 'rpc', typeof error.code === 'string' ? error.code : 'RpcError',
        collected.networkClass, collected.unresolved,
      );
    }
    payload = data;
  } catch (err) {
    return unavailable(
      event,
      err instanceof RiskRpcTimeoutError ? 'rpc_timeout' : 'rpc',
      err instanceof Error ? err.name : 'UnknownError',
      collected.networkClass, collected.unresolved,
    );
  }

  if (!payload || typeof payload.decision !== 'string') {
    // A response we cannot read is a decision we did not take.
    return unavailable(
      event, 'rpc', 'MalformedResponse',
      collected.networkClass, collected.unresolved,
    );
  }

  const decision = payload.decision;
  const reasons  = Array.isArray(payload.reasons) ? payload.reasons : [];
  const score    = typeof payload.score === 'number' ? payload.score : 0;
  const reviewId = payload.review_id ?? null;

  // An `unknown_event` reason means the database did not recognise the event
  // name — the vocabulary drifted. Surfaced as its own outcome so the
  // resulting "everything is allowed on this surface" is loud rather than
  // indistinguishable from a quiet day.
  const outcome: RiskOutcome =
    reasons.some((r) => r.rule === 'unknown_event') ? 'unknown_event' : 'evaluated';

  if (decision !== 'allow' || outcome === 'unknown_event') {
    emit({
      event, decision, outcome, score, reasons,
      unresolved: collected.unresolved,
      networkClass: collected.networkClass,
      reviewId,
    });
  }

  return {
    decision,
    allowed: decision === 'allow',
    score,
    reasons,
    outcome,
    eventId: payload.event_id ?? null,
    reviewId,
    stepUps: policy.stepUps,
    refusalMessage: refusalMessageFor(decision),
  };
}

/**
 * The common call-site shape: may this proceed without a step-up?
 *
 * `friction` counts as proceed on a surface that offers no step-up
 * (`stepUps: []`), because inventing one would be the indiscriminate
 * challenge the audit rules out. On a surface that does offer one, friction
 * is NOT proceed — the caller must run the step-up and then act.
 */
export function mayProceed(decision: RiskDecision): boolean {
  if (decision.decision === 'allow') return true;
  return decision.decision === 'friction' && decision.stepUps.length === 0;
}
