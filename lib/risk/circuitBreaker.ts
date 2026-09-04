// ─── Per-practice exposure and the payout circuit breaker ───────────────
//
// The merchant half of the loss chain, and the half no per-request rule can
// reach. A colluding or compromised practice does not look wrong one bill at
// a time — it looks wrong in aggregate, and only over a window:
//
//   • it is carrying more open exposure than the platform intends to have
//     with any single merchant;
//   • it has been paid more this week than the platform intends to release
//     to any single merchant;
//   • every new customer on the platform this week went to it;
//   • its plans do not survive instalment 1, because the cards are stolen or
//     the customers do not exist.
//
// The last is the sharpest signal and the cheapest to compute. A real
// practice's plans almost all clear instalment 1 — the patient is standing
// at the counter with their own card. So a first-payment rate that collapses
// is a merchant problem, not a customer problem.
//
// ─── WHY THIS IS A SEPARATE PASS, NOT A RULE ────────────────────────────
//
// The velocity rules in policy.ts are evaluated on the request that triggers
// them, from tokens. These metrics come from `plans`, `payments` and
// `payouts` — the financial record — and they are only meaningful over days.
// Computing them inside every plan acceptance would put four aggregate
// queries on the hot path of the money flow to answer a question whose
// answer changes hourly at most.
//
// So: a monitor evaluates the posture on a schedule and TRIPS the breaker,
// which writes a standing block on the practice dimension. From then on
// every `evaluate_risk` call that carries that practice enforces it — plan
// acceptance, counter sessions and payout release alike — without any of
// those call sites knowing a breaker exists.

import { createClient as createServiceClient } from '@supabase/supabase-js';
import type { RiskAction } from './vocabulary';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

function svc(): Svc {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export type PracticePosture = {
  practiceId: string;
  windowDays: number;
  openExposure: number;
  windowPayout: number;
  newCustomers: number;
  plansInWindow: number;
  /** null when there were no plans to divide — a brand-new practice is not
   *  read as perfect, and is not read as failing either. */
  firstPaymentRate: number | null;
};

export type BreakerThresholds = {
  windowDays: number;
  maxOpenExposure: number;
  maxWindowPayout: number;
  maxNewCustomers: number;
  minFirstPaymentRate: number;
  /** Below this many plans the first-payment rate is noise, not evidence.
   *  Two plans and one decline is 50%, and means nothing. */
  firstPaymentMinSample: number;
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Launch-scale defaults, meant to be revisited against real volume.
 *
 * Sized so that a single large, honest practice sits comfortably under all
 * of them and a merchant being used to cash out hits at least one within a
 * week. They are environment-overridable for the same reason the budgets
 * are: an operator must be able to tighten them during an incident without
 * waiting for a deploy.
 */
export function breakerThresholds(): BreakerThresholds {
  return {
    windowDays:            envNumber('RISK_PRACTICE_WINDOW_DAYS', 7),
    maxOpenExposure:       envNumber('RISK_PRACTICE_MAX_EXPOSURE', 400_000),
    maxWindowPayout:       envNumber('RISK_PRACTICE_MAX_WEEKLY_PAYOUT', 300_000),
    maxNewCustomers:       envNumber('RISK_PRACTICE_MAX_NEW_CUSTOMERS', 120),
    minFirstPaymentRate:   envNumber('RISK_PRACTICE_MIN_FIRST_PAYMENT_RATE', 0.6),
    firstPaymentMinSample: envNumber('RISK_PRACTICE_FIRST_PAYMENT_MIN_SAMPLE', 10),
  };
}

export type BreakerBreach = {
  metric: 'open_exposure' | 'window_payout' | 'new_customers' | 'first_payment_rate';
  observed: number;
  threshold: number;
};

/**
 * Pure. Given a posture and the thresholds, which limits are breached.
 *
 * Separated from both the reading and the tripping so the judgement itself
 * is testable without a database and without freezing anyone — which is also
 * how a monitor can report "this practice is close" without acting.
 */
export function breachesFor(
  posture: PracticePosture,
  thresholds: BreakerThresholds,
): BreakerBreach[] {
  const breaches: BreakerBreach[] = [];

  if (posture.openExposure > thresholds.maxOpenExposure) {
    breaches.push({ metric: 'open_exposure', observed: posture.openExposure, threshold: thresholds.maxOpenExposure });
  }
  if (posture.windowPayout > thresholds.maxWindowPayout) {
    breaches.push({ metric: 'window_payout', observed: posture.windowPayout, threshold: thresholds.maxWindowPayout });
  }
  if (posture.newCustomers > thresholds.maxNewCustomers) {
    breaches.push({ metric: 'new_customers', observed: posture.newCustomers, threshold: thresholds.maxNewCustomers });
  }
  if (
    posture.firstPaymentRate !== null &&
    posture.plansInWindow >= thresholds.firstPaymentMinSample &&
    posture.firstPaymentRate < thresholds.minFirstPaymentRate
  ) {
    breaches.push({
      metric: 'first_payment_rate',
      observed: posture.firstPaymentRate,
      threshold: thresholds.minFirstPaymentRate,
    });
  }

  return breaches;
}

/**
 * How hard to hold.
 *
 * A single breach parks the practice for a human: the honest large practice
 * and the mule look identical on any ONE metric, and freezing a real
 * merchant's money on one number is a business incident of its own.
 *
 * Two or more breaches at once is a different claim. Exposure AND a
 * collapsed first-payment rate, or a payout spike AND a flood of new
 * identities, is not a busy Tuesday — nothing legitimate produces that
 * combination, and payouts stop until someone says otherwise.
 */
export function breakerAction(breaches: BreakerBreach[]): RiskAction {
  if (breaches.length === 0) return 'allow';
  return breaches.length >= 2 ? 'deny' : 'review';
}

/** Read the four metrics for one practice. */
export async function readPracticePosture(
  practiceId: string,
  windowDays = breakerThresholds().windowDays,
  client?: Svc,
): Promise<PracticePosture | null> {
  const db = client ?? svc();
  const { data, error } = await db.rpc('practice_risk_posture', {
    p_practice_id: practiceId,
    p_window_days: windowDays,
  });
  if (error || !data) return null;

  return {
    practiceId:       String(data.practice_id ?? practiceId),
    windowDays:       Number(data.window_days ?? windowDays),
    openExposure:     Number(data.open_exposure ?? 0),
    windowPayout:     Number(data.window_payout ?? 0),
    newCustomers:     Number(data.new_customers ?? 0),
    plansInWindow:    Number(data.plans_in_window ?? 0),
    firstPaymentRate: data.first_payment_rate === null || data.first_payment_rate === undefined
      ? null
      : Number(data.first_payment_rate),
  };
}

export type BreakerOutcome =
  | { tripped: false; posture: PracticePosture | null; breaches: BreakerBreach[] }
  | { tripped: true;  posture: PracticePosture; breaches: BreakerBreach[]; action: RiskAction; reviewId: string | null };

/**
 * Evaluate one practice and, if it breaches, trip the breaker.
 *
 * Returns without acting when the posture cannot be read. A monitor that
 * froze every practice because one query failed would be a worse incident
 * than the one it is watching for — and unlike a per-request decision, there
 * is no customer waiting on this answer, so the safe move is to skip this
 * pass and try again on the next.
 */
export async function evaluatePracticeBreaker(
  practiceId: string,
  opts?: { thresholds?: BreakerThresholds; client?: Svc; ttlSecs?: number },
): Promise<BreakerOutcome> {
  const thresholds = opts?.thresholds ?? breakerThresholds();
  const db = opts?.client ?? svc();

  const posture = await readPracticePosture(practiceId, thresholds.windowDays, db);
  if (!posture) return { tripped: false, posture: null, breaches: [] };

  const breaches = breachesFor(posture, thresholds);
  if (breaches.length === 0) return { tripped: false, posture, breaches };

  const action = breakerAction(breaches);
  const reason = breaches
    .map((b) => `${b.metric} ${b.observed} > ${b.threshold}`)
    .join('; ');

  const { data, error } = await db.rpc('trip_practice_circuit_breaker', {
    p_practice_id: practiceId,
    p_reason:      reason.slice(0, 500),
    p_action:      action,
    p_ttl_secs:    opts?.ttlSecs ?? 604_800,
    p_actor:       null,
  });

  console.error(JSON.stringify({
    event: 'risk_practice_breaker',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    practice_id: practiceId,
    action,
    breaches,
    posture,
    tripped: !error,
  }));

  return {
    tripped: true,
    posture,
    breaches,
    action,
    reviewId: (data && (data as { review_id?: string }).review_id) ?? null,
  };
}
