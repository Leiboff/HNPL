import { paystackRequest } from '@/lib/paystack';
import { chargeAmountCents } from './dunning';

// ─── Atomic claim-and-charge for one installment ────────────────────────────
//
// This module is the PERMANENT canonical entry point for "charge one
// installment now". The daily collection cron calls it per due row; the
// patient self-settle action (lib/payments/selfSettleInstalment.ts)
// also funnels through here so the cron-vs-self-settle race resolves
// at the SAME atomic UPDATE and the patient can never be double-charged;
// the future preauth engine will reuse it and swap only the inner
// Paystack call (charge_authorization → capture-from-hold). Anywhere
// else in the codebase that needs to fire a single installment charge
// SHOULD migrate to this helper too — owning the race/idempotency
// logic once is the whole point.
//
// Semantics:
//
//   1. Atomic claim. A single conditional UPDATE flips the row from
//      ('scheduled' | 'failed') → 'processing' AND increments
//      retry_count, writes a fresh Paystack reference, and stamps
//      last_dunning_attempt_date = today. The WHERE clause re-checks
//      every eligibility predicate (status, retry cap, due_date) so
//      two concurrent runners can't both claim the same row — the
//      second one's UPDATE matches zero rows.
//
//   2. Plan / patient lookups. Done after the claim. If the plan is no
//      longer active or has no stored authorization code, the claim is
//      reverted (status restored to its pre-claim value) and the row
//      is left for the operator to investigate.
//
//   3. Paystack charge. Amount = instalment + accrued dunning fees, so
//      a later success recovers everything owed in one transaction.
//      A transport-level error (Paystack unreachable / 5xx) leaves the
//      row in 'processing' on purpose — we do NOT know if the charge
//      reached Paystack, so reverting to 'failed' could cause a
//      double-charge on the next retry. Manual reconciliation by the
//      admin via Paystack dashboard is the recovery path.
//
//   4. Definitive outcome via webhook. A card decline arrives via
//      Paystack's charge.failed webhook (NOT inside this function);
//      the webhook handler flips the row to 'failed', writes a
//      failure_reason, and advances the dunning ladder (consecutive
//      counter, possibly a R100 fee, next_attempt_date). The next
//      daily cron run re-evaluates retry eligibility based on the
//      ladder-set next_attempt_date.
//
// Retry cap: MAX_ATTEMPTS = 6 — the natural maximum of the dunning
// ladder (Days 0,1,7,8,14,15). Backstop only; the ladder normally
// terminates earlier when the fee cap is reached.

export const MAX_ATTEMPTS = 6;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvcClient = any;

export type AttemptOutcome =
  | { kind: 'charged';         paymentId: string; reference: string; attemptNumber: number; amountChargedCents: number }
  | { kind: 'claim_lost';      paymentId: string; reason: 'already_claimed' | 'not_eligible' | 'plan_not_active' | 'no_authorization_code' | 'no_email' }
  | { kind: 'transport_error'; paymentId: string; error: string; reference: string };

/**
 * Atomically claim a payment row and fire the charge.
 *
 * The caller is expected to have already filtered to plausibly-eligible
 * rows; this function re-checks every condition atomically and is safe
 * to call concurrently with itself for the same paymentId.
 *
 * `selfSettle: true` is the patient-initiated "Pay now" path:
 *   • adds 'defaulted' to the claim's accepted statuses (so a cap-hit
 *     instalment can still be settled by the patient);
 *   • skips the due_date and retry_count guards (self-settle isn't a
 *     retry — it's a one-shot manual collection).
 * The atomic claim primitive is otherwise identical to the cron path:
 * a single conditional UPDATE flips the row to 'processing', so a
 * concurrent cron attempt + patient self-settle still resolve to
 * exactly ONE charge — whichever UPDATE wins.
 */
export async function attemptChargeInstalment(
  svc: SvcClient,
  paymentId: string,
  options: { today?: string; selfSettle?: boolean } = {},
): Promise<AttemptOutcome> {
  const todayStr = options.today ?? new Date().toISOString().slice(0, 10);
  const selfSettle = options.selfSettle === true;

  // ── 1. Snapshot the current row so we can revert on later failure
  //       and compute the next retry_count / reference deterministically.
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

  // Reference includes the attempt number so each retry has a unique
  // Paystack reference. The webhook matches reference → peach_payment_id
  // exactly; the value we write into peach_payment_id is always the
  // reference of the LATEST attempt.
  const reference = `hnpl_${paymentId.replace(/-/g, '').slice(0, 16)}_a${nextAttempt}`;

  // ── 2. Atomic claim. Re-checks status (and retry_count + due_date
  //       on the cron path) all in the WHERE clause so concurrent
  //       callers can't double-claim. Also stamps
  //       last_dunning_attempt_date = today so a same-day cron re-run
  //       (which filters on this column) is a no-op.
  //
  //       Self-settle widens the accepted statuses to include
  //       'defaulted' and drops the due_date / retry_count guards —
  //       the patient is paying off the row regardless of where the
  //       ladder is. The status filter is still the lock primitive,
  //       so the cron-vs-self-settle race still resolves at exactly
  //       one winner.
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

  // From here on, if anything goes wrong we may need to REVERT the claim
  // to leave the row in a re-pickable state.
  type ClaimLostReason = Extract<AttemptOutcome, { kind: 'claim_lost' }>['reason'];
  async function revert(reason: ClaimLostReason): Promise<AttemptOutcome> {
    // Only revert if WE still hold the claim — the .eq('status','processing')
    // guard makes the revert a no-op if some other actor flipped the row
    // in the interim (e.g. a webhook from a half-completed prior attempt).
    // The trailing .select('id') makes the operation explicitly terminal
    // (consistent with the claim above) and is observable from tests.
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

  // ── 3. Plan + patient email. Service-role bypasses RLS.
  const { data: plan } = await svc
    .from('plans')
    .select('paystack_authorization_code, patient_id, status')
    .eq('id', current.plan_id)
    .maybeSingle();

  if (!plan || plan.status !== 'active') {
    return revert('plan_not_active');
  }
  if (!plan.paystack_authorization_code) {
    return revert('no_authorization_code');
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

  // ── 4. Fire the charge. Amount = instalment + accrued fees, so a
  //       success recovers everything owed in one transaction. The
  //       result is non-final — the webhook flips status to 'collected'
  //       on charge.success or 'failed' on charge.failed (and the
  //       webhook also advances the ladder on .failed). A throw here
  //       is a TRANSPORT error (network, Paystack 5xx) and is logged
  //       for manual reconciliation; the row stays in 'processing' on
  //       purpose (see header comment).
  const amountChargedCents = chargeAmountCents(Number(current.amount), previousFees);

  try {
    await paystackRequest('/transaction/charge_authorization', {
      method: 'POST',
      body: JSON.stringify({
        authorization_code: plan.paystack_authorization_code,
        email:              profile.email,
        amount:             amountChargedCents,
        currency:           'ZAR',
        reference,
      }),
    });
  } catch (err) {
    return {
      kind:      'transport_error',
      paymentId,
      error:     err instanceof Error ? err.message : String(err),
      reference,
    };
  }

  return { kind: 'charged', paymentId, reference, attemptNumber: nextAttempt, amountChargedCents };
}
