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
import {
  assessApplicantRing,
  recordIdentitySignals,
  type RawSignals,
} from '@/lib/security/identitySignals';

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
  /**
   * Request-scoped signals for ring assessment. REQUIRED, and required on
   * purpose — see the header note "why the ring gate is not optional".
   */
  ring: RingContext;
  /** Injectable for tests. */
  now?: Date;
};

/**
 * What the ring gate needs from the request that this file cannot get for
 * itself: who the applicant is as an IDENTITY (not an account), and the
 * device/network/instrument they arrived on.
 *
 * `identityHash` is profiles.sa_id_lookup_hash. It is nullable because an
 * unverified patient genuinely has no identity to correlate on — but note
 * that such a patient is refused upstream by the onboarding gate long
 * before reaching here, so in practice a null means a call site that has
 * not fetched it, and the gate degrades to a no-op rather than pretending
 * to have looked.
 */
export type RingContext = {
  identityHash: string | null;
  signals:      RawSignals;
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
        | 'ring_blocked'
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
  /**
   * Deliberately says nothing about why.
   *
   * A refusal that named the signal — "too many accounts on this device" —
   * would be a tuning oracle: an operator could bisect their way to the
   * exact threshold and keep every future ring one identity under it. The
   * customer gets a route to a human instead, which is the honest thing to
   * offer someone this control may have caught wrongly.
   */
  ring_blocked:
    'We need to check a few things before we can set up this plan. Please contact support and we\'ll sort it out.',
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
  // ─── The ring gate ─────────────────────────────────────────────────
  //
  // Runs BEFORE the headroom read, because a blocked claim should spend
  // nothing — not a read, and certainly not the lock the RPC takes.
  const ring = await ringGate(input);
  if (!ring.ok) return ring.outcome;

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

// ─── ringGate — the correlation control, at the money door ─────────────
//
// WHY IT IS HERE AND NOT AT SIGNUP
//
// This function is the one door onto a payment schedule: acceptPlan,
// payWithSavedCard and initiateCheckout all pass through it. That makes it
// the only place a correlation control can sit and be certain of catching
// every route to credit — which is exactly the property audit A-05 found
// missing when the three doors enforced different gates.
//
// It is also the right MOMENT. Refusing a ring at signup would refuse
// people before they have done anything, on the weakest evidence we will
// ever have about them, and would teach an operator which handset to
// discard while it cost them nothing. Refusing at the credit claim spends
// the attacker's whole setup — rented identity, verification session,
// registered card — before it fails.
//
// WHY THE GATE IS NOT OPTIONAL
//
// `ring` is a required field on ClaimCreditInput. An optional one would
// compile at every existing call site and silently do nothing, which is
// precisely how audit F-10 happened: approved_credit_limit was written,
// displayed, and read by no gate anywhere for months. A required field
// makes the typechecker enumerate the call sites, so a new door onto
// credit cannot be opened without answering this question.
//
// ─── PHASE 1: BLOCK THE EXTREME, OBSERVE THE REST ──────────────────────
//
// 'block' refuses. 'review' does NOT — it logs an alert and lets the claim
// proceed.
//
// That is a deliberate boundary, not an oversight, and it follows the
// precedent this codebase already set for sa_id_lookup_hash in migration
// 0096: the mechanism lands first, and the consequence waits until a human
// has seen what the mechanism actually catches. A 'review' verdict is only
// meaningful if something reviews it, and there is no plan-review queue
// today. Wiring 'review' to a refusal before that queue exists would strand
// real patients at a counter with no recourse — the same trade
// lib/onboarding/dhaVerification.ts names explicitly when it says its
// review route is only acceptable if the queue is staffed.
//
// THE CONDITION FOR FLIPPING IT, stated so it is a decision and not a
// drift: once the alerts below have run against real traffic long enough
// to know the false-positive rate on 'review', and once a human queue
// exists to receive them, 'review' should refuse too. Until then this
// control blocks only scores that clear RING_BLOCK_SCORE with
// corroboration from two independent kinds — a bar no household in the
// test suite comes close to.
//
// FAILING OPEN IS INHERITED, NOT RE-DECIDED HERE
//
// assessApplicantRing returns a degraded 'clear' when it cannot read the
// ledger; see the failure-posture note in lib/security/identitySignals.ts
// for why, and for what that concedes.

type RingGateResult = { ok: true } | { ok: false; outcome: ClaimCreditOutcome };

async function ringGate(input: ClaimCreditInput): Promise<RingGateResult> {
  const { identityHash, signals } = input.ring;

  // No identity, nothing to correlate on. Not a pass — an abstention.
  if (!identityHash) return { ok: true };

  let assessment;
  try {
    assessment = await assessApplicantRing({ identityHash, raw: signals });
  } catch (err) {
    // assessApplicantRing is written not to throw; this is belt and braces
    // so that a fraud control can never be the thing that breaks checkout.
    console.error('[ring-gate] assessment threw — allowing claim through', {
      planId: input.planId,
      message: err instanceof Error ? err.message : 'unknown',
    });
    return { ok: true };
  }

  // Logged for every non-clear verdict, including the ones we let through.
  // `degraded` is on the line because "we looked and found nothing" and "we
  // could not look" must never be the same log entry.
  if (assessment.verdict !== 'clear' || assessment.degraded) {
    console.warn('[ring-gate]', {
      planId:      input.planId,
      patientId:   input.patientId,
      verdict:     assessment.verdict,
      score:       assessment.score,
      kinds:       assessment.corroboratingKinds,
      degraded:    assessment.degraded,
      // Codes and weights only — the details carry counts, never values,
      // and nothing here can identify another patient.
      signals:     assessment.signals.map((s) => `${s.code}:${s.weight}`),
    });
  }

  if (assessment.verdict === 'block') {
    console.error('[ring-gate] REFUSED — credit claim blocked as part of an identity ring', {
      planId: input.planId, patientId: input.patientId, score: assessment.score,
    });
    // Deliberately NOT recorded. A refused claim contributed nothing to the
    // system, and writing it would let an attacker seed the ledger with
    // chosen keys by making claims they know will fail.
    return { ok: false, outcome: { ok: false, reason: 'ring_blocked', message: CLAIM_MESSAGES.ring_blocked } };
  }

  // ─── Contribute, having first been assessed ────────────────────────────
  //
  // ORDER IS THE WHOLE DESIGN HERE. Assess, then record.
  //
  // Recording first would put this applicant's own signals in the ledger
  // before counting it — and although count_identity_links excludes the
  // caller's identity_hash, an applicant whose hash was still null at
  // signup would then be counted as a stranger against themselves. Every
  // returning patient would appear to share their own device with one
  // other person. Assessing first makes that structurally impossible.
  //
  // WHY THE CREDIT CLAIM IS THE RIGHT PLACE TO WRITE
  //
  // A signal is only useful for correlation once it is attached to a
  // VERIFIED IDENTITY — rows with a null identity_hash are counted for
  // nobody (migration 0136), which is what stops anonymous signup spam
  // from being able to implicate real customers. At signup there is no
  // identity yet. Here there is one, and the applicant has just presented
  // a device, a network and often a card at the moment money is about to
  // move. That is the highest-value observation the system ever makes.
  //
  // The consequence, stated so it is not mistaken for a gap: the FIRST
  // members of a ring are recorded but not caught, because there was
  // nobody ahead of them to match. Each claim makes the next one harder,
  // and the ring is caught partway through rather than at its first
  // member. That is inherent to correlation — a first observation cannot
  // correlate with anything — not a defect in the placement.
  //
  // Best-effort and awaited: recordIdentitySignals never throws and never
  // blocks on failure, but it is awaited rather than floated because a
  // serverless invocation can be frozen the moment the response is
  // returned, and a dangling write is a silently empty ledger.
  await recordIdentitySignals({
    profileId:    input.patientId,
    identityHash,
    surface:      'accept_plan',
    raw:          signals,
  });

  return { ok: true };
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
