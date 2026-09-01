// ─── The one door onto a payment schedule ────────────────────────────────
//
// Every path that turns a bill into instalments goes through here:
// acceptPlan, payWithSavedCard and initiateCheckout. Before this file each
// one read the credit limit, decided, and wrote its own schedule — which is
// what made audit A-04 possible three times over, and what let the three
// doors drift apart on which gates they enforced (A-05).
//
// What this function does NOT do is decide anything. The decision and the
// write are one transaction inside `claim_credit_for_plan` (migration 0130),
// under a row lock on the patient's profile. This is the client for that
// function: it computes the split, calls it, and translates the coded refusal
// into copy.
//
// ─── WHY IT COMPUTES THE SPLIT AND THE RPC VALIDATES IT ────────────────
//
// `lib/finance.ts` is the one place this project computes money and the only
// place tested against known answers. Reimplementing
// `splitInstalmentsWithExcess` in plpgsql would give the system two
// definitions of a customer's schedule that could drift by a cent. So the
// arithmetic stays here and the RPC checks it: the amounts must reconcile to
// `plans.total_amount`, the excess must sit wholly on instalment 1, and the
// financed part must fit the headroom the RPC derives for itself under the
// lock. A caller that lies about any of those is refused.
//
// ─── THE OPTIMISTIC READ, AND THE ONE RETRY ────────────────────────────
//
// To compute the split we need to know the headroom, and the authoritative
// headroom is only knowable under the lock — inside the RPC. So this reads it
// unlocked first, splits against that, and calls. If another request claimed
// credit in between, the RPC refuses with `over_limit` AND returns the true
// available figure; we re-split against that and call once more.
//
// Exactly once. A second refusal means the headroom moved again, and at that
// point the honest answer to the customer is "try again" rather than an
// unbounded loop against a moving number.

import {
  splitInstalmentsWithExcess,
  calculatePaymentDates,
  MIN_FINANCED_RANDS,
} from '@/lib/finance';
import {
  outstandingExposure,
  CREDIT_LIMIT_REFUSAL,
  CREDIT_LIMIT_UNSET_REFUSAL,
  CREDIT_LIMIT_UNAVAILABLE_REFUSAL,
} from './creditLimit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

export type ClaimCreditInput = {
  planId:      string;
  patientId:   string;
  planType:    2 | 3;
  totalAmount: number;
  salaryDay:   number;
  /** The status the plan must currently be in. The RPC refuses otherwise. */
  expectedStatus: 'pending_acceptance' | 'pending_first_payment';
  termsVersion:   string;
  privacyVersion: string;
  /** Injectable for tests. */
  now?: Date;
};

export type ClaimCreditOutcome =
  | {
      ok: true;
      /** What HNPL is lending. */
      financed: number;
      /** What is collected up front on instalment 1 because it exceeded the allowance. */
      excess: number;
      instalments: number[];
      dueDates: Date[];
      /** The row the first charge fires against. */
      instalmentOneId: string;
    }
  | {
      ok: false;
      reason:
        | 'no_limit'
        | 'over_limit'
        | 'below_minimum'
        | 'plan_not_found'
        | 'schedule_survived'
        | 'unavailable';
      /** Copy for the customer. Never the raw database message. */
      message: string;
    };

export const CLAIM_MESSAGES = {
  /** Three of these are the copy `checkCreditLimit` used, imported rather
   *  than restated — the strings are what a customer reads, and two
   *  divergent copies of a refusal is how one of them ends up wrong. */
  no_limit:      CREDIT_LIMIT_UNSET_REFUSAL,
  unavailable:   CREDIT_LIMIT_UNAVAILABLE_REFUSAL,
  /** The allowance model means a bill above the headroom is SPLIT rather than
   *  refused (product decision 2026-09-02), so this now fires only when the
   *  headroom is too small to finance anything at all. The copy is the old
   *  over-limit refusal, which says the right thing for that case. */
  below_minimum: CREDIT_LIMIT_REFUSAL,
  plan_not_found:
    'This bill is no longer available to accept. Refresh your orders and try again.',
  schedule_survived:
    'This bill is already being paid. Please check your orders — don\'t pay a second time.',
  /** over_limit is only reachable after the retry, so the copy says so. */
  over_limit:
    'Your available balance changed while we were setting this up. Please try again.',
} as const;

/**
 * Read the headroom the way the RPC will, but without the lock — good enough
 * to compute a split against, and re-validated authoritatively inside.
 *
 * Returns null when the patient has no approved limit at all, which the
 * caller reports as `no_limit` without troubling the RPC.
 */
async function readAvailable(
  svc: Svc,
  patientId: string,
  excludePlanId: string,
): Promise<{ ok: true; available: number } | { ok: false; reason: 'no_limit' | 'unavailable' }> {
  const { data: profile, error } = await svc
    .from('profiles')
    .select('approved_credit_limit')
    .eq('id', patientId)
    .maybeSingle();

  if (error) {
    console.error('[claim-credit] profile read failed', { patientId, error: error.message });
    return { ok: false, reason: 'unavailable' };
  }

  const raw = profile?.approved_credit_limit as number | string | null | undefined;
  if (raw === null || raw === undefined) return { ok: false, reason: 'no_limit' };

  const limit = Number(raw);
  if (!Number.isFinite(limit)) return { ok: false, reason: 'no_limit' };

  const exposure = await outstandingExposure(svc, patientId, { excludePlanId });
  if (!exposure.ok) {
    console.error('[claim-credit] exposure read failed', { patientId });
    return { ok: false, reason: 'unavailable' };
  }

  return { ok: true, available: Math.round((limit - exposure.rands) * 100) / 100 };
}

type RpcClaim = {
  ok: boolean;
  error?: string;
  financed?: number | string;
  excess?: number | string;
  available?: number | string;
  instalment_one_id?: string;
};

async function callRpc(
  svc: Svc,
  input: ClaimCreditInput,
  amounts: number[],
  excess: number,
  dueDates: Date[],
): Promise<{ ok: true; claim: RpcClaim } | { ok: false }> {
  const { data, error } = await svc.rpc('claim_credit_for_plan', {
    p_plan_id:         input.planId,
    p_patient_id:      input.patientId,
    p_plan_type:       input.planType,
    p_amounts:         amounts,
    p_excess:          excess,
    p_due_dates:       dueDates.map((d) => d.toISOString().slice(0, 10)),
    p_expected_status: input.expectedStatus,
    p_terms_version:   input.termsVersion,
    p_privacy_version: input.privacyVersion,
  });

  if (error) {
    console.error('[claim-credit] claim_credit_for_plan RPC failed', {
      planId: input.planId, error: error.message,
    });
    return { ok: false };
  }
  return { ok: true, claim: (data ?? {}) as RpcClaim };
}

export async function claimCreditForPlan(
  svc: Svc,
  input: ClaimCreditInput,
): Promise<ClaimCreditOutcome> {
  const headroom = await readAvailable(svc, input.patientId, input.planId);
  if (!headroom.ok) {
    return { ok: false, reason: headroom.reason, message: CLAIM_MESSAGES[headroom.reason] };
  }

  const dueDates = calculatePaymentDates(input.now ?? new Date(), input.salaryDay, input.planType);

  /** One attempt against a given headroom figure. */
  async function attempt(available: number): Promise<ClaimCreditOutcome | { retryWith: number }> {
    if (available < MIN_FINANCED_RANDS) {
      return { ok: false, reason: 'below_minimum', message: CLAIM_MESSAGES.below_minimum };
    }

    const split = splitInstalmentsWithExcess(input.totalAmount, input.planType, available);
    const res   = await callRpc(svc, input, split.instalments, split.excess, dueDates);
    if (!res.ok) {
      return { ok: false, reason: 'unavailable', message: CLAIM_MESSAGES.unavailable };
    }

    const claim = res.claim;
    if (claim.ok) {
      return {
        ok: true,
        financed:        Number(claim.financed ?? split.financed),
        excess:          Number(claim.excess   ?? split.excess),
        instalments:     split.instalments,
        dueDates,
        instalmentOneId: String(claim.instalment_one_id),
      };
    }

    // The headroom moved between our unlocked read and the lock, and the RPC
    // reported what it actually is. Worth one more go with that number.
    if (claim.error === 'over_limit') {
      const corrected = Number(claim.available);
      if (Number.isFinite(corrected)) return { retryWith: corrected };
    }

    return refusal(claim.error);
  }

  const first = await attempt(headroom.available);
  if (!('retryWith' in first)) return first;

  // Exactly once. A second miss means the number is still moving, and the
  // honest answer is "try again" rather than a loop against it.
  const second = await attempt(first.retryWith);
  if ('retryWith' in second) {
    return { ok: false, reason: 'over_limit', message: CLAIM_MESSAGES.over_limit };
  }
  return second;
}

function refusal(code: string | undefined): ClaimCreditOutcome {
  switch (code) {
    case 'no_limit':          return { ok: false, reason: 'no_limit',          message: CLAIM_MESSAGES.no_limit };
    case 'below_minimum':     return { ok: false, reason: 'below_minimum',     message: CLAIM_MESSAGES.below_minimum };
    case 'over_limit':        return { ok: false, reason: 'over_limit',        message: CLAIM_MESSAGES.over_limit };
    case 'schedule_survived': return { ok: false, reason: 'schedule_survived', message: CLAIM_MESSAGES.schedule_survived };
    case 'plan_not_found':    return { ok: false, reason: 'plan_not_found',    message: CLAIM_MESSAGES.plan_not_found };
    // amounts_mismatch and excess_misplaced mean THIS code computed a split
    // the RPC would not accept — a bug here, not a customer problem. Report
    // it as unavailable and log loudly.
    default:
      console.error('[claim-credit] ALERT the RPC rejected our own split', { code });
      return { ok: false, reason: 'unavailable', message: CLAIM_MESSAGES.unavailable };
  }
}
