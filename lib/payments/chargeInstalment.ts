import { getPaymentProvider } from './provider';
import { chargeAmountCents, dunningFeesEnabled } from './dunning';
import { instalmentAttemptRef } from './peach/refs';
import { logPeachRawResponse } from './peach/logRawResponse';

// ─── Atomic claim-and-charge for one installment (Peach MIT) ────────
//
// Since the 0076 swap the inner charge call targets Peach Payments
// via lib/payments/provider. The atomic-claim primitive, retry-cap
// backstop, dunning-ladder feeder, and idempotency-via-reference
// story are UNCHANGED — this file is the single canonical entry
// point for "charge one instalment now" (cron + patient self-settle
// both funnel through here). The domain code around it is untouched.
//
// Semantics:
//
//   1. Atomic claim. A single conditional UPDATE flips the row from
//      ('scheduled' | 'failed') → 'processing', increments retry_count,
//      writes the fresh Peach merchantTransactionId, and stamps
//      last_dunning_attempt_date = today. The WHERE clause re-checks
//      every eligibility predicate so two concurrent runners can't
//      both claim the same row.
//
//   2. Plan / patient lookups. Done AFTER the claim. If the plan is
//      no longer active or has no stored registration id, the claim
//      is reverted and the row is left for manual review.
//
//   3. Peach charge. POST /v1/registrations/{registrationId}/payments
//      with:
//        entityId (recurring), amount (rands 2dp), currency=ZAR,
//        paymentType=DB, merchantTransactionId=<reference>,
//        standingInstruction.mode=REPEATED,
//        standingInstruction.source=MIT,
//        standingInstruction.type=INSTALLMENT (or UNSCHEDULED fallback
//          when initialTransactionId isn't available),
//        standingInstruction.initialTransactionId=<plan's initial>
//      A transport-level error (network / Peach 5xx) leaves the row
//      in 'processing' — we do NOT know whether the charge reached
//      Peach, so reverting to 'failed' could cause a double-charge
//      on the next retry.
//
//   4. Definitive outcome from the SYNCHRONOUS response. Since 0077
//      we're on the recurring API which returns a definitive
//      result.code inline — the provider adapter classifies it into
//      success/pending/rejected/error and the webhook is a bonus
//      reconciliation channel (same handlers, guarded by status
//      preconditions).
//
// Retry cap: MAX_ATTEMPTS = 6 (natural dunning-ladder maximum).

export const MAX_ATTEMPTS = 6;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvcClient = any;

export type AttemptOutcome =
  | { kind: 'charged';         paymentId: string; reference: string; attemptNumber: number; amountChargedCents: number; providerPaymentId?: string; resultCode?: string }
  | { kind: 'claim_lost';      paymentId: string; reason: 'already_claimed' | 'not_eligible' | 'plan_not_active' | 'no_registration_id' | 'no_email' }
  | { kind: 'transport_error'; paymentId: string; error: string; reference: string };

/**
 * Atomically claim a payment row and fire the Peach MIT charge.
 *
 * The caller is expected to have already filtered to plausibly-
 * eligible rows; this function re-checks every condition atomically
 * and is safe to call concurrently with itself for the same paymentId.
 *
 * `selfSettle: true` is the patient-initiated "Pay now" path.
 */
export async function attemptChargeInstalment(
  svc: SvcClient,
  paymentId: string,
  options: { today?: string; selfSettle?: boolean } = {},
): Promise<AttemptOutcome> {
  const todayStr = options.today ?? new Date().toISOString().slice(0, 10);
  const selfSettle = options.selfSettle === true;

  // ── 1. Snapshot the current row.
  const { data: current } = await svc
    .from('payments')
    .select('id, status, retry_count, amount, plan_id, patient_id, due_date, dunning_fees_cents')
    .eq('id', paymentId)
    .maybeSingle();

  if (!current) {
    return { kind: 'claim_lost', paymentId, reason: 'not_eligible' };
  }

  const previousStatus  = current.status as 'scheduled' | 'failed' | 'processing' | string;
  const previousRetries = (current.retry_count ?? 0) as number;
  const previousFees    = (current.dunning_fees_cents ?? 0) as number;
  const nextAttempt     = previousRetries + 1;

  if (!selfSettle && nextAttempt > MAX_ATTEMPTS) {
    return { kind: 'claim_lost', paymentId, reason: 'not_eligible' };
  }

  // Compact 16-char Peach ref (Visa/Mastercard 3DS2 mandate limits
  // merchantTransactionId to ≤16 chars). Deterministic per (payment,
  // attempt): re-entering the same attempt regenerates the same ref
  // so Peach dedups if we happen to double-fire mid-flight; a fresh
  // attempt gets a fresh ref. Persisted in payments.peach_payment_id
  // for webhook echoback reconciliation — that column is provider-
  // neutral by design (0076 comment).
  const reference = instalmentAttemptRef(paymentId, nextAttempt);

  // ── 2. Atomic claim.
  const allowedStatuses = selfSettle
    ? ['scheduled', 'failed', 'defaulted']
    : ['scheduled', 'failed'];

  let claimBuilder = svc
    .from('payments')
    .update({
      status:                    'processing',
      retry_count:               nextAttempt,
      peach_payment_id:          reference,
      last_dunning_attempt_date: todayStr,
    })
    .eq('id', paymentId)
    .in('status', allowedStatuses);

  if (!selfSettle) {
    claimBuilder = claimBuilder
      .lt('retry_count', MAX_ATTEMPTS)
      .lte('due_date', todayStr);
  }

  const { data: claimed, error: claimErr } = await claimBuilder.select('id');

  if (claimErr || !claimed || claimed.length === 0) {
    return { kind: 'claim_lost', paymentId, reason: 'already_claimed' };
  }

  // From here on, if anything goes wrong we may need to REVERT the claim.
  type ClaimLostReason = Extract<AttemptOutcome, { kind: 'claim_lost' }>['reason'];
  async function revert(reason: ClaimLostReason): Promise<AttemptOutcome> {
    await svc
      .from('payments')
      .update({
        status:           previousStatus,
        retry_count:      previousRetries,
        peach_payment_id: null,
      })
      .eq('id', paymentId)
      .eq('status', 'processing')
      .select('id');
    return { kind: 'claim_lost', paymentId, reason };
  }

  // ── 3. Plan lookup — Peach registration id is now the reusable token.
  //       peach_initial_transaction_id is required for INSTALLMENT-type
  //       MIT charges (0077); we fall back to UNSCHEDULED when it's
  //       missing so cards tokenised before the migration still work.
  const { data: plan } = await svc
    .from('plans')
    .select('peach_registration_id, peach_initial_transaction_id, patient_id, status')
    .eq('id', current.plan_id)
    .maybeSingle();

  if (!plan || plan.status !== 'active') {
    return revert('plan_not_active');
  }
  if (!plan.peach_registration_id) {
    return revert('no_registration_id');
  }

  const patientId = (plan.patient_id ?? current.patient_id) as string;
  const { data: profile } = await svc
    .from('profiles')
    .select('email')
    .eq('id', patientId)
    .single();

  if (!profile?.email) {
    return revert('no_email');
  }

  // ── 4. Fire the charge via the provider adapter. Result-code
  //       interpretation lives in the provider; the atomic-claim
  //       primitive doesn't need to know it. A transport error (any
  //       throw / status='error') leaves the row in 'processing'.
  //
  // Fee gate (compliance): while dunningFeesEnabled() is OFF, we charge
  // the instalment principal ONLY — never any accrued dunning fee. This
  // is the load-bearing charge-point gate: it protects BOTH rows failing
  // after the gate deployed (whose ledger stays 0 anyway) AND any legacy
  // row that accrued dunning_fees_cents BEFORE the gate — that fee is
  // never debited while OFF. dunning_fees_cents itself is left untouched
  // (the ledger is not erased, just not charged).
  const feesEnabled  = dunningFeesEnabled();
  const feesToCharge = feesEnabled ? previousFees : 0;
  if (!feesEnabled && previousFees > 0) {
    console.log('[chargeInstalment] accrued dunning fee NOT charged [gated]', {
      paymentId, accruedFeesCents: previousFees,
    });
  }
  const amountChargedCents = chargeAmountCents(Number(current.amount), feesToCharge);

  // Standing instruction for a fixed-instalment MIT charge:
  //
  //   INSTALLMENT + initialTransactionId when the plan has captured
  //   its initial CIT transaction id (populated by the Checkout V2
  //   return route + webhook, and by payWithSavedCard on first success).
  //
  //   UNSCHEDULED fallback when initialTransactionId is null — this
  //   applies to cards tokenised before 0077 landed, and to plans
  //   using a card previously registered via the "add card" flow that
  //   haven't yet made their first successful MIT charge.
  //
  // TODO(dina): once every active plan has peach_initial_transaction_id
  // backfilled from historic webhook data, tighten this to require the
  // INSTALLMENT branch and treat missing initial as a claim-lost.
  const initial = (plan as { peach_initial_transaction_id?: string | null }).peach_initial_transaction_id ?? null;
  const standingInstruction = initial
    ? { mode: 'REPEATED' as const, source: 'MIT' as const, type: 'INSTALLMENT' as const, initialTransactionId: initial }
    : { mode: 'REPEATED' as const, source: 'MIT' as const, type: 'UNSCHEDULED' as const };

  const provider = getPaymentProvider();
  const result = await provider.chargeSavedCard({
    registrationId:        plan.peach_registration_id,
    amountCents:           amountChargedCents,
    merchantTransactionId: reference,
    currency:              'ZAR',
    standingInstruction,
  });

  // Phase-2 chain-root capture: log the FULL raw MIT response (card-
  // redacted) so we can confirm whether this MIT was ACCEPTED with the
  // initialTransactionId we sent (the CIT's `id`) and what Peach echoes
  // back (standingInstruction.initialTransactionId / scheme ids). Grep
  // "PEACH MIT CAPTURE". Diagnostic only — the SI we send is unchanged.
  logPeachRawResponse(
    `PEACH MIT CAPTURE (instalment paymentId=${paymentId} attempt=${nextAttempt} siType=${standingInstruction.type} sentInitial=${initial ?? 'none'}):`,
    result.raw,
  );

  if (result.status === 'error') {
    return {
      kind:      'transport_error',
      paymentId,
      error:     result.resultDescription ?? 'transport error',
      reference,
    };
  }

  // For 'success', 'pending', 'rejected' — the webhook is authoritative
  // on flipping instalment state. We return the transport-level outcome
  // so the caller can log / tally.
  return {
    kind:              'charged',
    paymentId,
    reference,
    attemptNumber:     nextAttempt,
    amountChargedCents,
    providerPaymentId: result.providerPaymentId,
    resultCode:        result.resultCode,
  };
}
