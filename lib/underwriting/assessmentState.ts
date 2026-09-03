// ─── Limit lifecycle: staleness, cooldown, re-assessment ────────────────
//
// Pure. Takes a snapshot of the patient's assessment state and a clock,
// and answers what should happen when they ask for a plan.
//
// ─── STALE IS NOT DECLINED ─────────────────────────────────────────────
//
// Bureau data ages, and `Bureau_Expenses` in particular is a snapshot that
// cannot include obligations taken on after sign-up — including plans with
// other BNPL providers, most of whom do not report on the same cadence as
// traditional credit. So a limit expires.
//
// Expiry means RE-ASSESS BEFORE APPROVING, never refuse. A patient whose
// limit has aged out has done nothing wrong and has not been assessed as
// a bad risk; they have simply not been assessed recently. Conflating the
// two would refuse good customers for the crime of coming back.
//
// ─── COOLDOWN IS MATCHED ON THE ID, NOT THE ACCOUNT ────────────────────
//
// A declined applicant who re-registers with a fresh email and phone is
// the same person, and each fresh assessment costs real money at Experian.
// So the cooldown is keyed on the SA ID blind index, which survives a new
// account. Only SUBSTANTIVE declines set it — a pending assessment must
// never lock anybody out for three months because a SOAP endpoint was
// briefly unavailable.

import { lastDayOfMonth } from '@/lib/salaryDates';
import { STALENESS_MONTHS, DECLINE_COOLDOWN_MONTHS, type ScorecardBand } from './coefficients';

/**
 * Add whole months, clamping the day to the target month's length.
 *
 * Naive arithmetic produces 31 February and, worse, month 13. Both matter
 * here: a cooldown set on the 31st must land on a real date, and a
 * six-month staleness window crosses a year boundary for half the year.
 */
export function addMonths(from: Date, months: number): Date {
  const year  = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const targetYear  = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  // lastDayOfMonth takes a 0-INDEXED month, matching Date's own convention.
  const day = Math.min(from.getUTCDate(), lastDayOfMonth(targetYear, targetMonth));

  return new Date(Date.UTC(
    targetYear, targetMonth, day,
    from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds(),
  ));
}

function asDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type AssessmentStatus = 'active' | 'expired' | 'declined' | 'pending';

/** The patient's current assessment state, as stored on the profile. */
export type AssessmentSnapshot = {
  limit: number | null;
  /** profiles.credit_check_completed_at */
  assessedAt: string | Date | null;
  status: AssessmentStatus | null;
  cooldownUntil: string | Date | null;
  band: ScorecardBand | null;
};

/** Why a re-assessment is being run. Written to the log. */
export type AssessmentTrigger = 'signup' | 'staleness' | 'increase_request' | 'admin';

/** When does this assessment expire? Null when there is nothing to expire. */
export function expiresAt(
  snapshot: AssessmentSnapshot,
  months: number = STALENESS_MONTHS,
): Date | null {
  const assessed = asDate(snapshot.assessedAt);
  return assessed === null ? null : addMonths(assessed, months);
}

/**
 * Has the assessment aged out?
 *
 * Fails CLOSED. An `assessedAt` we cannot parse is treated as stale rather
 * than as fresh: the alternative is a limit of unbounded age surviving
 * forever because a timestamp was malformed, which is the failure mode
 * that gives away money. A snapshot with no timestamp at all is likewise
 * stale — there is nothing to have expired, so there is nothing in force.
 */
export function isStale(
  snapshot: AssessmentSnapshot,
  now: Date,
  months: number = STALENESS_MONTHS,
): boolean {
  if (asDate(snapshot.assessedAt) === null) return true;
  const expiry = expiresAt(snapshot, months);
  return expiry === null || now.getTime() >= expiry.getTime();
}

/** Is the patient inside a decline cooldown? */
export function isInCooldown(snapshot: AssessmentSnapshot, now: Date): boolean {
  const until = asDate(snapshot.cooldownUntil);
  return until !== null && now.getTime() < until.getTime();
}

/** The cooldown expiry for a decline recorded now. */
export function cooldownFrom(
  declinedAt: Date,
  months: number = DECLINE_COOLDOWN_MONTHS,
): Date {
  return addMonths(declinedAt, months);
}

export type PlanRequestGate =
  /** A usable limit is in force. No bureau calls. */
  | { kind: 'allowed'; limit: number }
  /** Run the pipeline again before deciding. NOT a refusal. */
  | { kind: 'reassess'; reason: 'stale' | 'no_assessment' | 'increase_request' | 'admin' }
  /** Inside the decline cooldown. */
  | { kind: 'blocked'; reason: 'cooldown'; until: Date }
  /** An assessment is in flight or could not complete. */
  | { kind: 'pending' };

/**
 * What should happen when this patient asks for a plan?
 *
 * This is the check that must NOT make a bureau call for a patient who
 * already has a valid limit — the common case by far, and the one a
 * refactor is most likely to regress into re-assessing every time.
 */
export function gatePlanRequest(
  snapshot: AssessmentSnapshot,
  now: Date,
  opts: { requestedIncrease?: boolean; adminTriggered?: boolean; stalenessMonths?: number } = {},
): PlanRequestGate {
  const months = opts.stalenessMonths ?? STALENESS_MONTHS;

  // The cooldown outranks everything: an applicant inside it must not
  // reach a billable enquiry by any route.
  if (isInCooldown(snapshot, now)) {
    return { kind: 'blocked', reason: 'cooldown', until: asDate(snapshot.cooldownUntil)! };
  }

  // An explicit request outranks a usable limit, but not the cooldown.
  if (opts.adminTriggered)    return { kind: 'reassess', reason: 'admin' };
  if (opts.requestedIncrease) return { kind: 'reassess', reason: 'increase_request' };

  if (snapshot.status === 'pending') return { kind: 'pending' };

  if (snapshot.status === 'declined') {
    // Declined but out of cooldown — they may be assessed again.
    return { kind: 'reassess', reason: 'no_assessment' };
  }

  // Parsed, not raw: a malformed timestamp is not an assessment.
  if (snapshot.limit === null || asDate(snapshot.assessedAt) === null) {
    return { kind: 'reassess', reason: 'no_assessment' };
  }

  if (snapshot.status === 'expired' || isStale(snapshot, now, months)) {
    return { kind: 'reassess', reason: 'stale' };
  }

  return { kind: 'allowed', limit: snapshot.limit };
}

/** True when this gate outcome requires no bureau call at all. */
export function requiresNoBureauCall(gate: PlanRequestGate): boolean {
  return gate.kind === 'allowed' || gate.kind === 'blocked' || gate.kind === 'pending';
}

/**
 * The status a completed assessment should leave on the profile.
 *
 * `pending` is deliberately reachable: an assessment we could not complete
 * leaves the patient in a state that retries rather than one that refuses.
 */
export function statusForOutcome(
  outcome: 'approved' | 'declined' | 'pending',
): AssessmentStatus {
  switch (outcome) {
    case 'approved': return 'active';
    case 'declined': return 'declined';
    case 'pending':  return 'pending';
  }
}
