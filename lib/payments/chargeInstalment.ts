import { paystackRequest } from '@/lib/paystack';

// ─── Atomic claim-and-charge for one installment ────────────────────────────
//
// This module is the PERMANENT canonical entry point for "charge one
// installment now". The daily collection cron calls it per due row; the
// future preauth engine will reuse it and swap only the inner Paystack
// call (charge_authorization → capture-from-hold). Anywhere else in the
// codebase that needs to fire a single installment charge SHOULD migrate
// to this helper too — owning the race/idempotency logic once is the
// whole point.
//
// Semantics:
//
//   1. Atomic claim. A single conditional UPDATE flips the row from
//      ('scheduled' | 'failed') → 'processing' AND increments
//      retry_count AND writes a fresh Paystack reference. The WHERE
//      clause re-checks every eligibility predicate (status, retry
//      cap, due_date) so two concurrent runners can't both claim the
//      same row — the second one's UPDATE matches zero rows.
//
//   2. Plan / patient lookups. Done after the claim. If the plan is no
//      longer active or has no stored authorization code, the claim is
//      reverted (status restored to its pre-claim value) and the row
//      is left for the operator to investigate.
//
//   3. Paystack charge. Fired with the freshly-claimed reference. A
//      transport-level error (Paystack unreachable / 5xx) leaves the
//      row in 'processing' on purpose — we do NOT know if the charge
//      reached Paystack, so reverting to 'failed' could cause a
//      double-charge on the next retry. Manual reconciliation by the
//      admin via Paystack dashboard is the recovery path.
//
//   4. Definitive outcome via webhook. A card decline arrives via
//      Paystack's charge.failed webhook (NOT inside this function);
//      the existing webhook handler flips the row to 'failed' with a
//      failure_reason. The next daily cron run re-evaluates retry
//      eligibility and may re-attempt.
//
// Retry cap: MAX_ATTEMPTS = 4 (one initial + three retries). The cron
// runs writeOffExceededAttempts() at the start of each batch to flip
// any row that has hit the cap into 'written_off' before iterating
// the due queue.

export const MAX_ATTEMPTS = 4;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvcClient = any;

export type AttemptOutcome =
  | { kind: 'charged';         paymentId: string; reference: string; attemptNumber: number }
  | { kind: 'claim_lost';      paymentId: string; reason: 'already_claimed' | 'not_eligible' | 'plan_not_active' | 'no_authorization_code' | 'no_email' }
  | { kind: 'transport_error'; paymentId: string; error: string; reference: string };

/**
 * Atomically claim a payment row and fire the charge.
 *
 * The caller is expected to have already filtered to plausibly-eligible
 * rows; this function re-checks every condition atomically and is safe
 * to call concurrently with itself for the same paymentId.
 */
export async function attemptChargeInstalment(
  svc: SvcClient,
  paymentId: string,
  options: { today?: string } = {},
): Promise<AttemptOutcome> {
  const todayStr = options.today ?? new Date().toISOString().slice(0, 10);

  // ── 1. Snapshot the current row so we can revert on later failure
  //       and compute the next retry_count / reference deterministically.
  const { data: current } = await svc
    .from('payments')
    .select('id, status, retry_count, amount, plan_id, patient_id, due_date')
    .eq('id', paymentId)
    .maybeSingle();

  if (!current) {
    return { kind: 'claim_lost', paymentId, reason: 'not_eligible' };
  }

  const previousStatus  = current.status as 'scheduled' | 'failed' | 'processing' | string;
  const previousRetries = (current.retry_count ?? 0) as number;
  const nextAttempt     = previousRetries + 1;

  if (nextAttempt > MAX_ATTEMPTS) {
    return { kind: 'claim_lost', paymentId, reason: 'not_eligible' };
  }

  // Reference includes the attempt number so each retry has a unique
  // Paystack reference. The webhook matches reference → peach_payment_id
  // exactly; the value we write into peach_payment_id is always the
  // reference of the LATEST attempt.
  const reference = `hnpl_${paymentId.replace(/-/g, '').slice(0, 16)}_a${nextAttempt}`;

  // ── 2. Atomic claim. Re-checks status, retry cap, due_date all in
  //       the WHERE clause so concurrent callers can't double-claim.
  const { data: claimed, error: claimErr } = await svc
    .from('payments')
    .update({
      status:           'processing',
      retry_count:      nextAttempt,
      peach_payment_id: reference,
    })
    .eq('id', paymentId)
    .in('status', ['scheduled', 'failed'])
    .lt('retry_count', MAX_ATTEMPTS)
    .lte('due_date', todayStr)
    .select('id');

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

  // ── 4. Fire the charge. The result is non-final — the webhook flips
  //       status to 'collected' on charge.success or 'failed' on
  //       charge.failed. A throw here is a TRANSPORT error (network,
  //       Paystack 5xx) and is logged for manual reconciliation; the
  //       row stays in 'processing' on purpose (see header comment).
  try {
    await paystackRequest('/transaction/charge_authorization', {
      method: 'POST',
      body: JSON.stringify({
        authorization_code: plan.paystack_authorization_code,
        email:              profile.email,
        amount:             Math.round(Number(current.amount) * 100),
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

  return { kind: 'charged', paymentId, reference, attemptNumber: nextAttempt };
}

// ─── Write-off sweep ────────────────────────────────────────────────────────
//
// Promotes any 'failed' row whose retry_count has reached MAX_ATTEMPTS
// into 'written_off'. Runs at the START of every cron batch so any rows
// that exhausted their retries on the prior day are surfaced and won't
// be reattempted. Returns the ids of rows it touched.

export async function writeOffExceededAttempts(svc: SvcClient): Promise<string[]> {
  const { data } = await svc
    .from('payments')
    .update({ status: 'written_off' })
    .eq('status', 'failed')
    .gte('retry_count', MAX_ATTEMPTS)
    .select('id');
  return (data ?? []).map((r: { id: string }) => r.id);
}
