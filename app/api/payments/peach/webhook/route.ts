// Node.js runtime required — crypto.createHmac + timingSafeEqual
// are not available in the Edge runtime.
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyWebhookSignature,
  parseConfigWebhookBody,
  parseFormEventBody,
  type DecryptedWebhook,
  type WebhookPaymentPayload,
} from '@/lib/payments/peach/webhook';
import { classifyResultCode } from '@/lib/payments/peach/resultCodes';
import { peachRefPurpose } from '@/lib/payments/peach/refs';
import { saveCardForPatient as saveCardForPatientPeach } from '@/lib/payments/peach/saveCardForPatient';
import { sendPushToUser } from '@/lib/notifications/sendPush';
import { chargeAmountCents, addDaysISO, DUNNING_FEE_CENTS, FEE_GRACE_PERIOD_DAYS } from '@/lib/payments/dunning';
import {
  notifyAttemptFailed,
  notifyRecoverySucceeded,
  formatISODate,
} from '@/lib/payments/dunningNotifications';
import { getPaymentProvider } from '@/lib/payments/provider';
import { activateFirstInstalment } from '@/lib/payments/activateFirstInstalment';
import { attemptChargeInstalment } from '@/lib/payments/chargeInstalment';
import { logPeachRawResponse } from '@/lib/payments/peach/logRawResponse';
import { failCheckoutSessionsForPlan } from '@/lib/checkout/declineCheckoutSessions';

// ─── Peach Checkout webhook receiver ────────────────────────────────
//
// TWO distinct deliveries land here:
//
//   (1) INITIAL configuration webhook — sent when the URL is first
//       registered in the Dashboard. Content-Type: application/json.
//       The Dashboard requires a 200 response for the URL to be
//       accepted. The body carries setup metadata including the
//       verification code the merchant pastes back into the Dashboard.
//       We LOG the code prominently and ALWAYS return 200 — even if
//       PEACH_CHECKOUT_SECRET_TOKEN is unset (chicken-and-egg: we
//       can't have set up the token before the URL is registered).
//
//   (2) EVENT webhooks (all subsequent deliveries) — Content-Type:
//       application/x-www-form-urlencoded. HMAC-SHA256-signed via
//       four headers. Payload uses dotted field names for nested
//       paths. State flips are idempotent, precondition-guarded so
//       double-delivery is a no-op.
//
// Signed message (per docs — reference-webhooks + checkout-webhooks):
//   `${timestamp}.${webhookId}.${url}.${payload}`
//   HMAC-SHA256 keyed on the Checkout Secret Token.
//
// The `url` component is the exact URL Peach POSTed to (= the URL
// configured in the Dashboard). Read from env PEACH_CHECKOUT_WEBHOOK_URL
// so it's stable regardless of Vercel's proxy headers.

function svc() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ─── Push + formatting helpers ─────────────────────────────────────

function formatRandCents(rands: number): string {
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

async function safePush(
  userId: string,
  payload: {
    type?:  'payment' | 'plan' | 'account' | 'general';
    title:  string;
    body:   string;
    url?:   string;
    tag?:   string;
  },
): Promise<void> {
  try {
    await sendPushToUser(userId, { type: payload.type ?? 'payment', ...payload });
  } catch (err) {
    console.warn('[peach-webhook] push send failed (non-fatal)', {
      userId,
      message: (err as Error).message,
    });
  }
}

// ─── First-payment activation ──────────────────────────────────────
//
// The write logic lives in lib/payments/activateFirstInstalment.ts —
// shared with payWithSavedCard's synchronous success path so the two
// paths cannot diverge. Every write inside the helper is precondition-
// guarded, so if the sync path landed first this reconciliation is a
// no-op.

// ─── Payment-success dispatch ──────────────────────────────────────

// ─── Did we actually receive what we were owed? ─────────────────────────
//
// THE DEFECT (audit 2026-09-01, F-09a)
//
// Nothing in this route ever read payload.amount or payload.currency. A
// success was established from result.code ALONE, and the row was marked
// collected whatever sum had actually settled. A partial capture, a
// currency mismatch, or a capture smaller than the instalment all closed
// out as payment in full — and, on instalment 1, released a payout for 94%
// of plans.total_amount.
//
// It is the missing half of a pair. F-02 let a patient rewrite
// payments.amount before initiating the charge; this is why nobody
// noticed. There was no point in the system where "what we asked for" and
// "what arrived" were compared, so both numbers could be wrong
// independently and the ledger would still balance on paper.
//
// TOLERANCE
//
// Exact, in integer cents, with ONE allowance: a capture LARGER than
// expected is accepted and logged rather than refused. Over-collection is
// not a fraud shape — nobody attacks themselves by paying more — and
// refusing it would strand real money that has already left a real card
// with no path back through this route. Under-collection by even one cent
// is refused: that is the direction the money goes missing in.
//
// EXPECTED AMOUNT
//
// payments.amount plus any dunning fees already posted on the row, which
// is exactly what chargeAmountCents computes for the charge itself — so
// the comparison is against the figure we actually asked the processor
// for, not against a re-derivation that could drift from it.
//
// A payload with NO amount field is accepted with a warning rather than
// refused. Peach's own event shapes vary by product and this route already
// tolerates that (see parseFormEventBody); turning a missing optional
// field into a refusal would mean declining to reconcile real settled
// money, which is worse than the check being best-effort on that path.

type AmountVerdict =
  | { ok: true;  note?: string }
  | { ok: false; reason: string };

function verifySettledAmount(
  payload:      WebhookPaymentPayload,
  expectedCents: number,
): AmountVerdict {
  const currency = payload.currency;
  if (currency && currency.toUpperCase() !== 'ZAR') {
    return { ok: false, reason: `currency ${currency} is not ZAR` };
  }

  if (payload.amount === undefined || payload.amount === null || payload.amount === '') {
    return { ok: true, note: 'delivery carried no amount field — not verified' };
  }

  const settled = Number(payload.amount);
  if (!Number.isFinite(settled)) {
    return { ok: false, reason: `unparseable amount ${JSON.stringify(payload.amount)}` };
  }

  const settledCents = Math.round(settled * 100);
  if (settledCents < expectedCents) {
    return {
      ok: false,
      reason: `settled ${settledCents}c is short of the expected ${expectedCents}c`,
    };
  }
  if (settledCents > expectedCents) {
    return { ok: true, note: `settled ${settledCents}c exceeds the expected ${expectedCents}c — accepted` };
  }
  return { ok: true };
}

/**
 * Refuse to settle, loudly. Money has moved at the processor and we are
 * declining to write it off against this instalment, so this is an
 * operator-actionable state and not something to swallow at info level.
 */
function refuseSettlement(context: Record<string, unknown>): void {
  console.error('[peach-webhook] ALERT amount-mismatch — NOT marking collected', context);
}

async function handlePaymentSuccess(payload: WebhookPaymentPayload): Promise<void> {
  const reference = payload.merchantTransactionId;
  if (!reference) {
    console.warn('[peach-webhook] payment.success: missing merchantTransactionId — cannot reconcile');
    return;
  }
  const supabase = svc();

  // Refund/reversal events (PAYMENT + paymentType RF/RV) are ignored:
  // the product has no refund flow (nothing initiates one), so there's
  // nothing to reconcile. Safe no-op — log and return rather than fall
  // through to the payment-row lookup (an RF ref matches no payment).
  if (payload.paymentType === 'RF' || payload.paymentType === 'RV') {
    console.log('[peach-webhook] ignoring refund/reversal event (no refund flow)', {
      reference, paymentType: payload.paymentType,
    });
    return;
  }

  const { data: payment } = await supabase
    .from('payments')
    .select('id, plan_id, instalment_number, patient_id, status, retry_count, dunning_fees_cents, amount, kind')
    .eq('peach_payment_id', reference)
    .maybeSingle();

  // Standalone card-registration path — no payment row; just save
  // the card. Purpose 'r' identifies the compact peach ref as a Flow B
  // add-card event. (The old `|| startsWith('hnpl_reg_')` fallback for
  // pre-compact-ref rows is removed — only compact `bnr…` refs are minted
  // now, and any legacy checkout session expired long ago.)
  if (!payment && peachRefPurpose(reference) === 'r') {
    await handleCardRegistrationSuccess(supabase, payload);
    return;
  }

  if (!payment) {
    console.warn('[peach-webhook] payment.success: no payment row for reference', reference);
    return;
  }

  if (payment.kind === 'settlement') {
    await handleSettlementChargeSuccess(supabase, payment, reference, payload);
    return;
  }

  const { data: plan } = await supabase
    .from('plans')
    .select('id, status, total_amount, practice_id, patient_id, provider_member_id, peach_initial_transaction_id')
    .eq('id', payment.plan_id)
    .maybeSingle();

  if (!plan) {
    console.error('[peach-webhook] payment.success: plan not found', payment.plan_id);
    return;
  }

  const now = new Date().toISOString();

  // ── What actually settled has to match what we charged ──
  //
  // Ahead of every state flip below, including instalment 1's activation
  // and its payout. See verifySettledAmount above for the tolerance and
  // why an over-capture is allowed through.
  const expectedCents = chargeAmountCents(
    Number(payment.amount),
    (payment.dunning_fees_cents ?? 0) as number,
  );
  const verdict = verifySettledAmount(payload, expectedCents);
  if (!verdict.ok) {
    refuseSettlement({
      reference,
      paymentId:        payment.id,
      planId:           plan.id,
      instalmentNumber: payment.instalment_number,
      expectedCents,
      reason:           verdict.reason,
      note:             'money may have moved at Peach — reconcile by hand before releasing any payout',
    });
    return;
  }
  if (verdict.note) {
    console.warn('[peach-webhook] payment.success: amount check', { reference, note: verdict.note });
  }

  // ── Instalment 1 — first-payment activation ──
  if (payment.instalment_number === 1) {
    if (plan.status === 'active') {
      console.log('[peach-webhook] payment.success: plan already active (duplicate)', plan.id);
      return;
    }
    if (plan.status !== 'pending_first_payment') {
      console.warn('[peach-webhook] payment.success: unexpected plan status for instalment 1', plan.status);
      return;
    }

    // Store the registrationId + initialTransactionId for future MIT
    // charges. The V2 return route may have already written these;
    // both writes are idempotent (guarded by IS NULL).
    if (payload.registrationId) {
      await supabase
        .from('plans')
        .update({ peach_registration_id: payload.registrationId })
        .eq('id', plan.id)
        .is('peach_registration_id', null);

      // Save the card, non-fatal (plan still activates).
      if (payload.card) {
        try {
          await saveCardForPatientPeach(
            plan.patient_id,
            {
              registrationId: payload.registrationId,
              // paymentBrand is top-level (sibling of `card`); fall back
              // to nested only for older/test shapes.
              brand:          payload.paymentBrand ?? payload.card.paymentBrand ?? null,
              last4:          payload.card.last4Digits  ?? null,
              expiryMonth:    payload.card.expiryMonth  ? Number(payload.card.expiryMonth) : null,
              expiryYear:     payload.card.expiryYear   ? Number(payload.card.expiryYear)  : null,
              holder:         payload.card.holder       ?? null,
            },
            supabase,
          );
        } catch (err) {
          console.error('[peach-webhook] payment.success: card save failed (non-fatal)', err instanceof Error ? err.message : err);
        }
      }
    }

    // Stamp initialTransactionId — required for every subsequent MIT
    // charge on this plan. The webhook's `payload.id` IS the initial
    // transaction id when this is the first successful CIT capture.
    if (payload.id && !plan.peach_initial_transaction_id) {
      await supabase
        .from('plans')
        .update({ peach_initial_transaction_id: payload.id })
        .eq('id', plan.id)
        .is('peach_initial_transaction_id', null);
    }

    const activateResult = await activateFirstInstalment(supabase, {
      paymentId: payment.id,
      plan: {
        id:           plan.id,
        total_amount: plan.total_amount,
        practice_id:  plan.practice_id,
        provider_member_id: plan.provider_member_id ?? null,
        patient_id:   plan.patient_id  ?? null,
      },
      now,
    });
    if (activateResult.ok) {
      console.log('[peach-webhook] payment.success: plan activated', { planId: plan.id, reference });
      await safePush(plan.patient_id, {
        type:  'plan',
        title: 'Plan activated',
        body:  `Your ${formatRandCents(Number(plan.total_amount))} plan is live. We'll handle the rest.`,
        url:   `/patient/orders/${plan.id}`,
        tag:   `plan:${plan.id}:activated`,
      });
    } else {
      console.error('[peach-webhook] activateFirstInstalment failed', {
        planId: plan.id,
        step:   activateResult.step,
        error:  activateResult.error,
      });
    }
    return;
  }

  // ── Instalments 2+ — recurring collection ──

  if (payment.status === 'collected') {
    console.log('[peach-webhook] payment.success: instalment already collected (duplicate)', { paymentId: payment.id, reference });
    return;
  }

  const wasRecovery =
    Number(payment.retry_count ?? 0) > 1 ||
    Number(payment.dunning_fees_cents ?? 0) > 0;

  const { error: pmtErr } = await supabase
    .from('payments')
    .update({
      status:              'collected',
      collected_at:        now,
      next_attempt_date:   null,
      // Clears a pending fee-grace decision left over from a failure this
      // success supersedes — e.g. the patient self-paid within the
      // 24-hour window. Harmless no-op when there was never one pending.
      dunning_grace_until: null,
    })
    .eq('id', payment.id);
  if (pmtErr) {
    console.error('[peach-webhook] payment.success: failed to mark instalment collected', pmtErr.message);
    return;
  }

  if (wasRecovery) {
    const collectedCents =
      Math.round(Number(payment.amount) * 100) +
      Number(payment.dunning_fees_cents ?? 0);
    await supabase.from('plan_events').insert({
      plan_id:    plan.id,
      patient_id: plan.patient_id,
      event_type: 'instalment_attempt_succeeded',
      payload: {
        payment_id:             payment.id,
        instalment_number:      payment.instalment_number,
        collected_amount_cents: collectedCents,
        via_self_settle:        false,
      },
    });
    await notifyRecoverySucceeded(supabase, {
      paymentId:            payment.id,
      collectedAmountCents: collectedCents,
      viaSelfSettle:        false,
    });
  }

  // ── Recover any other defaulted balance on this plan ──
  //
  // A 'defaulted' instalment is terminal to the normal cron ladder — it
  // is never retried (see lib/payments/chargeInstalment.ts's charge-
  // eligibility queries). Left alone, that debt just sits there frozen
  // forever, uncollected, even while the SAME card goes on to
  // successfully collect later instalments. A successful collection is
  // the best evidence we have that the card currently has funds, so we
  // use it as the trigger to also attempt any other defaulted instalment
  // on this plan — each as its OWN separate charge (own Peach reference,
  // own amount), never bundled into the instalment that just succeeded.
  // Reuses the exact same atomic-claim path the patient's own "Pay now"
  // button uses (attemptChargeInstalment with selfSettle:true), which is
  // the one eligibility mode that allows claiming a 'defaulted' row and
  // bypasses the retry-cap/due-date gates the normal ladder enforces.
  // The eventual outcome (collected or failed again) is reconciled by
  // this same webhook the normal way when Peach calls back for that
  // charge's own reference — no special-case handling needed here.
  const { data: defaultedSiblings } = await supabase
    .from('payments')
    .select('id')
    .eq('plan_id', plan.id)
    .eq('kind', 'instalment')
    .eq('status', 'defaulted');

  for (const sibling of (defaultedSiblings ?? []) as Array<{ id: string }>) {
    const recoveryOutcome = await attemptChargeInstalment(supabase, sibling.id, { selfSettle: true });
    console.log('[peach-webhook] payment.success: auto-recovery attempt on defaulted sibling', {
      planId:             plan.id,
      triggeringPaymentId: payment.id,
      defaultedPaymentId: sibling.id,
      outcome:            recoveryOutcome.kind,
    });
  }

  const { data: remaining } = await supabase
    .from('payments')
    .select('id')
    .eq('plan_id', plan.id)
    .eq('kind', 'instalment')
    .neq('status', 'collected');

  if (!remaining || remaining.length === 0) {
    await supabase.from('plans').update({ status: 'completed', completed_at: now }).eq('id', plan.id);
    console.log('[peach-webhook] payment.success: plan completed', { planId: plan.id });
    if (plan.patient_id) {
      await safePush(plan.patient_id, {
        type:  'plan',
        title: 'All paid up',
        body:  `Final payment collected. Your ${formatRandCents(Number(plan.total_amount))} plan is complete.`,
        url:   `/patient/orders/${plan.id}`,
        tag:   `plan:${plan.id}:completed`,
      });
    }
  } else {
    console.log('[peach-webhook] payment.success: instalment collected', {
      paymentId:        payment.id,
      instalmentNumber: payment.instalment_number,
      planId:           plan.id,
    });
    if (plan.patient_id) {
      const amt = Number((await supabase
        .from('payments')
        .select('amount')
        .eq('id', payment.id)
        .single()).data?.amount ?? 0);
      await safePush(plan.patient_id, {
        title: 'Payment collected',
        body:  `We collected ${formatRandCents(amt)}. Thanks!`,
        url:   `/patient/orders/${plan.id}`,
        tag:   `payment:${payment.id}:collected`,
      });
    }
  }
}

// ─── Payment failure dispatch ──────────────────────────────────────

async function handlePaymentFailure(payload: WebhookPaymentPayload): Promise<void> {
  const reference = payload.merchantTransactionId;
  if (!reference) {
    console.warn('[peach-webhook] payment.failure: missing merchantTransactionId — cannot reconcile');
    return;
  }
  const supabase = svc();

  // Refund/reversal events are ignored — no refund flow exists (see the
  // success path). Safe no-op.
  if (payload.paymentType === 'RF' || payload.paymentType === 'RV') {
    console.log('[peach-webhook] ignoring refund/reversal failure event (no refund flow)', {
      reference, paymentType: payload.paymentType,
    });
    return;
  }

  const { data: payment } = await supabase
    .from('payments')
    .select('id, plan_id, instalment_number, status, amount, consecutive_failed_attempts, dunning_fees_cents, retry_count, kind, pre_settlement_snapshot')
    .eq('peach_payment_id', reference)
    .maybeSingle();

  if (!payment && peachRefPurpose(reference) === 'r') {
    console.log('[peach-webhook] card_registration: charge failed — no action needed', {
      reference, reason: payload.result?.description ?? 'unknown',
    });
    return;
  }
  if (!payment) {
    console.warn('[peach-webhook] payment.failure: no payment row for reference', reference);
    return;
  }

  if (payment.kind === 'settlement') {
    await handleSettlementChargeFailed(supabase, payment, payload);
    return;
  }

  const { data: plan } = await supabase
    .from('plans')
    .select('id, status, patient_id, total_amount')
    .eq('id', payment.plan_id)
    .maybeSingle();
  if (!plan) {
    console.error('[peach-webhook] payment.failure: plan not found', payment.plan_id);
    return;
  }

  const failureReason = payload.result?.description ?? 'Charge failed';

  if (payment.instalment_number === 1) {
    if (plan.status === 'cancelled') {
      console.log('[peach-webhook] payment.failure: plan already cancelled (duplicate)', plan.id);
      return;
    }
    if (plan.status !== 'pending_first_payment') {
      console.warn('[peach-webhook] payment.failure: unexpected plan status for instalment 1', plan.status);
      return;
    }
    await supabase.from('payments').update({ status: 'failed', failure_reason: failureReason }).eq('id', payment.id);
    await supabase.from('plans').update({ status: 'cancelled' }).eq('id', plan.id);

    // ── Propagate to the POS counter session, if this bill had one ──────
    // A till-issued bill carries a checkout_sessions row (0085) whose stage is
    // what the till's "Today at this till" strip reports. The completion page
    // early-returns on a rejected charge BEFORE its own stage write, and
    // expire_stale_checkout_session only acts while the plan is still pending —
    // so the line above freezes the session at 'scanned' permanently, and the
    // front desk is told "Waiting on patient" about a card that was declined.
    //
    // Deliberately after the plan write and deliberately non-fatal: the plan
    // status is the authoritative record and must not be held hostage to a
    // second table, and this route answers 200 to everything rather than let
    // Peach's retry ladder amplify a bug into a state-flip storm. Passes the
    // handler's OWN service-role client rather than building a second one.
    const sessionClose = await failCheckoutSessionsForPlan(plan.id, supabase);
    if (sessionClose.error) {
      console.error('[peach-webhook] ALERT payment.failure: checkout_sessions propagation failed', {
        planId: plan.id, reference, error: sessionClose.error,
        note: 'plan IS cancelled; the till strip may still show this session as waiting',
      });
    }

    console.log('[peach-webhook] payment.failure: plan cancelled', {
      planId: plan.id, reference, failureReason, sessionsClosed: sessionClose.closed,
    });
    return;
  }

  if (payment.status === 'failed' || payment.status === 'defaulted') {
    console.log('[peach-webhook] payment.failure: instalment already in terminal/failed state (duplicate)', { paymentId: payment.id, reference, status: payment.status });
    return;
  }

  // ── No fee, no ladder advance, no terminal decision — not yet ──────────
  //
  // Direct product decision: a failed attempt no longer earns its Default
  // Fee (or a shot at terminal `defaulted`) the instant it fails. The
  // patient gets FEE_GRACE_PERIOD_DAYS to settle manually (Pay now)
  // first. This handler's ENTIRE job on a failure is now: mark it failed,
  // stamp the grace deadline, tell the patient. Nothing here touches
  // dunning_fees_cents, consecutive_failed_attempts, or next_attempt_date
  // — advanceLadderAfterFailure is not called from this file at all any
  // more. The daily cron's assessment pass (lib/payments/
  // assessDunningFee.ts) is the ONLY caller, and only once
  // dunning_grace_until has elapsed with the instalment STILL unpaid (a
  // self-pay within the window flips status away from 'failed' via the
  // success path above, which drops it out of that pass's query for free).
  const todayUtc = new Date().toISOString().slice(0, 10);
  const feesBefore = (payment.dunning_fees_cents ?? 0) as number;
  const attemptedAmountCents = chargeAmountCents(Number(payment.amount), feesBefore);
  const graceUntil = addDaysISO(todayUtc, FEE_GRACE_PERIOD_DAYS);

  await supabase
    .from('payments')
    .update({
      status:              'failed',
      failure_reason:       failureReason,
      dunning_grace_until:  graceUntil,
    })
    .eq('id', payment.id);

  await supabase.from('plan_events').insert({
    plan_id:    plan.id,
    patient_id: plan.patient_id,
    event_type: 'instalment_attempt_failed',
    payload: {
      payment_id:         payment.id,
      instalment_number:  payment.instalment_number,
      failure_reason:     failureReason,
      fee_grace_until:    graceUntil,
    },
  });

  await notifyAttemptFailed(supabase, {
    paymentId:                       payment.id,
    consecutiveFailedAttemptsBefore: (payment.consecutive_failed_attempts ?? 0) as number,
    feeAppliedCents:                 0,
    dunningFeesCentsAfter:           feesBefore,
    attemptedAmountCents,
    nextAttemptDate:                 null,
    feeGraceUntil:                   graceUntil,
  });

  if (plan.patient_id) {
    // NOTE: this file's formatRandCents takes RANDS (not cents — unlike the
    // same-named helper in dunningNotifications). attemptedAmountCents is
    // cents, so `/ 100` is the correct cents→rands conversion. Do NOT
    // "fix" the /100 away — see dunningFeeGate/route.test push-format pin.
    await safePush(plan.patient_id, {
      title: 'Payment didn\'t go through',
      body:  `We couldn't collect ${formatRandCents(attemptedAmountCents / 100)}. Pay by ${formatISODate(graceUntil)} to avoid a ${formatRandCents(DUNNING_FEE_CENTS / 100)} default fee.`,
      url:   `/patient/orders`,
      tag:   `payment:${payment.id}:failed:r${payment.retry_count ?? 0}`,
    });
  }
}

// ─── Standalone card-registration ──────────────────────────────────

async function handleCardRegistrationSuccess(supabase: ReturnType<typeof svc>, payload: WebhookPaymentPayload): Promise<void> {
  // Peach's form-urlencoded webhook delivers customParameters as
  // BRACKETED-FLAT keys (customParameters[SHOPPER_patientId]=…), and
  // parseFormEventBody (which only unflattens dotted names) keeps them as
  // literal top-level keys — it never builds a nested customParameters
  // object. Reading payload.customParameters?.SHOPPER_patientId (nested)
  // therefore ALWAYS missed → this card-reg backstop silently no-oped
  // (audit finding #4 / P2). Read the bracketed-flat key first, tolerating
  // the nested shape as a fallback for older/test deliveries — mirrors the
  // sync completion route (payment-methods/complete/page.tsx).
  const raw = payload as unknown as Record<string, unknown>;
  const patientId =
    (raw['customParameters[SHOPPER_patientId]'] as string | undefined) ??
    (raw['customParameters[patientId]']        as string | undefined) ??
    payload.customParameters?.SHOPPER_patientId ??
    payload.customParameters?.patientId;
  if (!patientId) {
    console.error('[peach-webhook] card_registration: no patientId in customParameters', { reference: payload.merchantTransactionId });
    return;
  }
  if (!payload.registrationId) {
    console.warn('[peach-webhook] card_registration: response missing registrationId', { reference: payload.merchantTransactionId });
    return;
  }
  if (!payload.card) {
    console.warn('[peach-webhook] card_registration: response missing card', { reference: payload.merchantTransactionId });
    return;
  }

  try {
    await saveCardForPatientPeach(
      patientId,
      {
        registrationId: payload.registrationId,
        // paymentBrand is top-level (sibling of `card`); fall back to
        // nested only for older/test shapes.
        brand:          payload.paymentBrand ?? payload.card.paymentBrand ?? null,
        last4:          payload.card.last4Digits  ?? null,
        expiryMonth:    payload.card.expiryMonth  ? Number(payload.card.expiryMonth) : null,
        expiryYear:     payload.card.expiryYear   ? Number(payload.card.expiryYear)  : null,
        holder:         payload.card.holder       ?? null,
      },
      supabase,
    );
  } catch (err) {
    console.error('[peach-webhook] card_registration: card save failed', err instanceof Error ? err.message : err);
  }
}

// ─── Settlement handlers ───────────────────────────────────────────

async function handleSettlementChargeSuccess(
  supabase: ReturnType<typeof svc>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settlement: any,
  reference: string,
  payload: WebhookPaymentPayload,
): Promise<void> {
  if (settlement.status === 'collected') {
    console.log('[peach-webhook] settlement payment.success: already collected (duplicate)', { settlementId: settlement.id, reference });
    return;
  }

  // Same amount gate as the instalment path (audit F-09a), and it matters
  // MORE here: one settlement row fans `collected` out to every instalment
  // it covers, so a short capture accepted at this point writes off a whole
  // plan. A settlement row carries its full total in `amount` and posts no
  // dunning fee of its own, so the expected figure is the row's own amount.
  const expectedCents = Math.round(Number(settlement.amount) * 100);
  const verdict = verifySettledAmount(payload, expectedCents);
  if (!verdict.ok) {
    refuseSettlement({
      reference,
      settlementId: settlement.id,
      planId:       settlement.plan_id,
      expectedCents,
      reason:       verdict.reason,
      note:         'settlement NOT applied — the instalments it covers stay as they were',
    });
    return;
  }
  if (verdict.note) {
    console.warn('[peach-webhook] settlement payment.success: amount check', { reference, note: verdict.note });
  }

  const now = new Date().toISOString();

  await supabase.from('payments').update({ status: 'collected', collected_at: now }).eq('id', settlement.id);

  const { data: covered } = await supabase
    .from('payments')
    .update({ status: 'collected', collected_at: now, next_attempt_date: null })
    .eq('settled_by_payment_id', settlement.id)
    .eq('status', 'processing')
    .select('id, instalment_number, amount, dunning_fees_cents');

  const { data: remaining } = await supabase
    .from('payments')
    .select('id')
    .eq('plan_id', settlement.plan_id)
    .eq('kind', 'instalment')
    .neq('status', 'collected');

  if (!remaining || remaining.length === 0) {
    await supabase.from('plans').update({ status: 'completed', completed_at: now }).eq('id', settlement.plan_id);
  }

  await supabase.from('plan_events').insert({
    plan_id:    settlement.plan_id,
    patient_id: settlement.patient_id,
    event_type: 'instalment_attempt_succeeded',
    payload: {
      settlement_id:          settlement.id,
      reference,
      collected_amount_cents: Math.round(Number(settlement.amount) * 100),
      via_settle_entire:      true,
      covered_count:          covered?.length ?? 0,
    },
  });

  await notifyRecoverySucceeded(supabase, {
    paymentId:            settlement.id,
    collectedAmountCents: Math.round(Number(settlement.amount) * 100),
    viaSelfSettle:        true,
  });

  if (settlement.patient_id) {
    await safePush(settlement.patient_id, {
      type:  'plan',
      title: 'Bill settled in full',
      body:  `Thanks — we collected ${formatRandCents(Number(settlement.amount))}.`,
      url:   `/patient/orders`,
      tag:   `settlement:${settlement.id}:collected`,
    });
  }
}

async function handleSettlementChargeFailed(
  supabase: ReturnType<typeof svc>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settlement: any,
  payload: WebhookPaymentPayload,
): Promise<void> {
  if (settlement.status === 'failed') return;
  const failureReason = payload.result?.description ?? 'Charge failed';

  await supabase.from('payments').update({ status: 'failed', failure_reason: failureReason }).eq('id', settlement.id);

  const snapshot = (settlement.pre_settlement_snapshot ?? {}) as Record<string, { status: string }>;
  const { data: coveredRows } = await supabase
    .from('payments')
    .select('id, status')
    .eq('settled_by_payment_id', settlement.id)
    .eq('status', 'processing')
    .eq('kind', 'instalment');

  for (const row of (coveredRows ?? []) as Array<{ id: string }>) {
    const prior = snapshot[row.id]?.status ?? 'failed';
    await supabase
      .from('payments')
      .update({ status: prior, settled_by_payment_id: null })
      .eq('id', row.id)
      .eq('settled_by_payment_id', settlement.id)
      .eq('status', 'processing');
  }

  await supabase.from('plan_events').insert({
    plan_id:    settlement.plan_id,
    patient_id: settlement.patient_id,
    event_type: 'instalment_attempt_failed',
    payload: {
      settlement_id:     settlement.id,
      reference:         payload.merchantTransactionId,
      failure_reason:    failureReason,
      reverted_count:    coveredRows?.length ?? 0,
      via_settle_entire: true,
    },
  });

  if (settlement.patient_id) {
    await safePush(settlement.patient_id, {
      title: 'Settlement payment didn\'t go through',
      body:  `Your bill is unchanged. Please check your card and try again.`,
      url:   `/patient/orders`,
      tag:   `settlement:${settlement.id}:failed`,
    });
  }
}

// ─── Registration events ───────────────────────────────────────────
// Fired when a stored card is created / updated / deleted via
// server-side APIs. Our happy path already handles registration
// creation inside the payment.success path (charge + create-token in
// one call); this handler covers the standalone lifecycle.

async function handleRegistrationEvent(payload: WebhookPaymentPayload, action: string | undefined): Promise<void> {
  const supabase = svc();
  if (action === 'DELETED' && payload.id) {
    await supabase.from('payment_methods').delete().eq('token', payload.id);
    await supabase.from('plans').update({ peach_registration_id: null }).eq('peach_registration_id', payload.id);
    console.log('[peach-webhook] registration DELETED — local rows removed', { registrationId: payload.id });
  } else {
    console.log('[peach-webhook] registration event', { action, id: payload.id });
  }
}

// ─── Route handler ─────────────────────────────────────────────────
//
// Posture per surface:
//
//   Verification probe (JSON body):
//     - Signature NOT required. Peach registers the URL BEFORE the
//       merchant configures HMAC signing; the probe often arrives
//       unsigned. If a signature IS present and verifies, we log
//       'signature ok'; if it fails, we log a warning but STILL 200 —
//       the Dashboard requires 200 to accept the URL.
//     - We log the whole body under a greppable prefix so the
//       verification code is trivially findable in Vercel logs.
//
//   Event (form-urlencoded body):
//     - Signature REQUIRED. Bad / missing signature → 401.
//     - Parsed via URLSearchParams with dotted-name unflattening.
//     - Dispatched into existing handlers; every state flip is
//       precondition-guarded so double-delivery is a no-op.
//     - Handler errors are caught + logged with an alertable prefix
//       and still return 200 (avoids Peach's retry ladder amplifying
//       a bug into a state-flip storm).
//
//   Malformed body (neither valid JSON nor parseable form) → 400.

// ─── Replay ledger ──────────────────────────────────────────────────────
//
// x-webhook-id is unique per delivery and is part of the signed message,
// so it cannot be substituted without the secret. Recording it is what
// stops a captured delivery being replayed inside the freshness window
// that verifyWebhookSignature now enforces (audit F-09b).
//
// ORDERING: checked BEFORE the handlers, recorded AFTER them.
//
// The check-before is the actual replay defence. The record-after is the
// lesson from the Didit receiver's F-13 bug, which claims its event id up
// front — so its own deliberate retry path re-entered, found the row it
// had just written, and answered "duplicate" to the retry it had asked
// for, permanently losing the verification. Recording on the way out means
// a crash mid-handler leaves no row, and Peach's retry re-processes
// against handlers that are individually precondition-guarded.
//
// The narrow cost of that ordering is that two deliveries of the same
// event arriving genuinely concurrently can both pass the check. That is
// the case the preconditions were always covering and still cover; it is a
// strictly better failure than silently dropping a real event.

async function alreadyDelivered(
  supabase: ReturnType<typeof svc>,
  webhookId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('peach_webhook_events')
    .select('webhook_id')
    .eq('webhook_id', webhookId)
    .maybeSingle();
  if (error) {
    // Fail OPEN. A ledger that cannot be read must not stop real payment
    // events being reconciled — the preconditions in every handler are
    // what make that safe, and losing a settlement is worse than
    // re-running an idempotent flip.
    console.error('[peach-webhook] replay-ledger read failed (processing anyway)', error.message);
    return false;
  }
  return !!data;
}

async function recordDelivery(
  supabase: ReturnType<typeof svc>,
  webhookId: string,
  meta: { eventType?: string; reference?: string },
): Promise<void> {
  const { error } = await supabase
    .from('peach_webhook_events')
    .upsert(
      { webhook_id: webhookId, event_type: meta.eventType ?? null, reference: meta.reference ?? null },
      { onConflict: 'webhook_id', ignoreDuplicates: true },
    );
  if (error) {
    console.error('[peach-webhook] replay-ledger write failed (event WAS processed)', {
      webhookId, error: error.message,
    });
  }
}

function computeWebhookUrl(request: NextRequest): string | null {
  // Prefer the env — set to match the Dashboard entry verbatim. Vercel
  // proxies can rewrite host/proto and NextRequest.url may not reflect
  // the public URL Peach dialed.
  const envUrl = process.env.PEACH_CHECKOUT_WEBHOOK_URL?.trim();
  if (envUrl) return envUrl;
  // Fallback: reconstruct from forwarded headers.
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const host  = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) return null;
  let pathname = '/api/payments/peach/webhook';
  try { pathname = new URL(request.url).pathname; } catch { /* keep default */ }
  return `${proto}://${host}${pathname}`;
}

export async function POST(request: NextRequest) {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  const body = await request.text();

  // ── (1) Verification / initial configuration probe ──────────────
  //
  // The Dashboard sends this as JSON when registering the URL. It
  // carries the verification code the merchant must paste back into
  // the Dashboard to complete registration. Signature MAY be missing
  // (the merchant has not yet configured HMAC signing at this point).
  if (contentType.includes('application/json')) {
    const parsed = parseConfigWebhookBody(body);
    if (!parsed) {
      // JSON claimed by content-type but body doesn't parse. Not a
      // valid probe; 400 so the Dashboard reports the URL as bad
      // rather than silently accepting nonsense.
      console.warn('[peach-webhook] verification probe: body claims JSON but did not parse', { bodyBytes: body.length });
      return NextResponse.json({ error: 'Body did not parse as JSON' }, { status: 400 });
    }

    // Prominent, greppable log lines. Peach does NOT document which
    // field carries the verification code on the initial probe, so
    // extracting a specific field would risk logging "undefined" if
    // the guess is wrong — leaving us unable to register without a
    // redeploy. Instead we dump the whole parsed body in TWO forms:
    //
    //   PEACH WEBHOOK VERIFICATION CODE: <single-line JSON>
    //     — one greppable line, useful for log-searching.
    //
    //   PEACH WEBHOOK PROBE BODY:
    //   <pretty-printed multi-line JSON>
    //     — readable dump, useful for eyeballing the object even when
    //       the field name is unfamiliar.
    //
    // The probe carries setup metadata, NOT card data — redacting
    // nothing is safe here. Do NOT copy this pattern to the event
    // path (which does carry card fingerprints).
    console.log('PEACH WEBHOOK VERIFICATION CODE:', JSON.stringify(parsed));
    console.log('PEACH WEBHOOK PROBE BODY:\n' + JSON.stringify(parsed, null, 2));
    console.log('[peach-webhook] verification probe: full JSON body logged above.');

    // Optional: if signature headers are present, verify them and log
    // the outcome — informative but not blocking.
    const algorithm = request.headers.get('x-webhook-signature-algorithm');
    const signature = request.headers.get('x-webhook-signature');
    if (algorithm && signature) {
      const secret = process.env.PEACH_CHECKOUT_SECRET_TOKEN;
      if (secret) {
        const url = computeWebhookUrl(request);
        const ok = verifyWebhookSignature({
          body,
          algorithm,
          timestamp: request.headers.get('x-webhook-timestamp'),
          webhookId: request.headers.get('x-webhook-id'),
          url,
          signature,
          secret,
        });
        console.log('[peach-webhook] verification probe: signature check', { ok });
      } else {
        console.log('[peach-webhook] verification probe: signature headers present but PEACH_CHECKOUT_SECRET_TOKEN unset (expected on first registration)');
      }
    } else {
      console.log('[peach-webhook] verification probe: unsigned (expected on first registration)');
    }

    return NextResponse.json({ received: true }, { status: 200 });
  }

  // ── (2) Signed event delivery ────────────────────────────────────
  //
  // Everything else (form-urlencoded events, or unrecognised content
  // types that carry a body Peach might sign) is treated as an event
  // and MUST verify.
  if (!contentType.includes('application/x-www-form-urlencoded') && contentType !== '') {
    console.warn('[peach-webhook] unexpected content-type on event delivery', { contentType });
    // Fall through to signature-check + parse — Peach may add
    // content-type variants in future; we don't want to reject on the
    // header alone. If body is unparseable below we 400.
  }

  const secret = process.env.PEACH_CHECKOUT_SECRET_TOKEN;
  if (!secret) {
    // Events REQUIRE the secret. Unlike the verification probe,
    // there's no chicken-and-egg here — the secret must be provisioned
    // before real events can arrive.
    console.error('[peach-webhook] PEACH_CHECKOUT_SECRET_TOKEN is not set — cannot verify event');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const algorithm = request.headers.get('x-webhook-signature-algorithm');
  const timestamp = request.headers.get('x-webhook-timestamp');
  const webhookId = request.headers.get('x-webhook-id');
  const signature = request.headers.get('x-webhook-signature');
  const url       = computeWebhookUrl(request);

  const valid = verifyWebhookSignature({
    body,
    algorithm,
    timestamp,
    webhookId,
    url,
    signature,
    secret,
  });

  if (!valid) {
    console.warn('[peach-webhook] event delivery: HMAC verification failed — 401', {
      hasAlgorithm: !!algorithm,
      hasTimestamp: !!timestamp,
      hasWebhookId: !!webhookId,
      hasSignature: !!signature,
      hasUrl:       !!url,
    });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const parsed: DecryptedWebhook | null = parseFormEventBody(body);
  if (!parsed) {
    console.warn('[peach-webhook] event delivery: body did not parse as form-urlencoded event', { bodyBytes: body.length });
    return NextResponse.json({ error: 'Malformed event body' }, { status: 400 });
  }

  const { type, action, payload } = parsed;

  // Replay check — after the signature (an unauthenticated delivery never
  // reaches the ledger) and before any handler. webhookId is non-null here:
  // verifyWebhookSignature refuses without it.
  const ledger = svc();
  if (await alreadyDelivered(ledger, webhookId!)) {
    console.log('[peach-webhook] duplicate delivery — already processed', {
      webhookId, reference: (payload as WebhookPaymentPayload).merchantTransactionId,
    });
    return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
  }

  console.log('[peach-webhook] event received:', {
    type,
    action,
    reference:  (payload as WebhookPaymentPayload).merchantTransactionId,
    resultCode: (payload as WebhookPaymentPayload).result?.code,
    checkoutId: (payload as WebhookPaymentPayload).checkoutId,
    webhookId,
  });

  try {
    if (type === 'PAYMENT') {
      const p = payload as WebhookPaymentPayload;
      // Phase-2 chain-root capture: log the FULL webhook payload (card-
      // redacted) so any scheme/CIT transaction id Peach delivers via the
      // webhook (cardholderInitiatedTransactionId / schemeTransactionId /
      // standingInstruction.initialTransactionId) is visible. Grep
      // "PEACH WEBHOOK PAYMENT CAPTURE". Diagnostic only.
      logPeachRawResponse('PEACH WEBHOOK PAYMENT CAPTURE:', p);
      const classified = classifyResultCode(p.result?.code);
      if (classified === 'success') {
        await handlePaymentSuccess(p);
      } else if (classified === 'rejected') {
        await handlePaymentFailure(p);
      } else {
        console.log('[peach-webhook] PAYMENT pending — waiting for terminal event', { reference: p.merchantTransactionId, resultCode: p.result?.code });
      }
    } else if (type === 'REGISTRATION') {
      await handleRegistrationEvent(payload as WebhookPaymentPayload, action);
    } else {
      console.log('[peach-webhook] unhandled event type — acknowledging without action', { type, action });
    }
  } catch (err) {
    // Alertable prefix — silent drops are invisible today, so we
    // stamp a clearly-greppable marker on the log line. Still 200
    // to avoid Peach's retry ladder amplifying a bug into a state-
    // flip storm.
    console.error('[peach-webhook] ALERT handler-threw', {
      type,
      action,
      reference: (payload as WebhookPaymentPayload).merchantTransactionId,
      error:     err instanceof Error ? err.message : String(err),
      stack:     err instanceof Error ? err.stack   : undefined,
    });
    // Deliberately NOT recorded. A delivery that threw did not complete,
    // and Peach's retry is the mechanism that finishes it — marking it
    // delivered here would reproduce F-13 exactly.
    return NextResponse.json({ received: true }, { status: 200 });
  }

  await recordDelivery(ledger, webhookId!, {
    eventType: type,
    reference: (payload as WebhookPaymentPayload).merchantTransactionId,
  });

  return NextResponse.json({ received: true }, { status: 200 });
}

// Not used from the route directly, but exported so we can verify
// the provider is wired in tests without instantiating the full route.
export const __internals = { getPaymentProvider };
