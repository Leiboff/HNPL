// Node.js runtime required — crypto.createHmac + timingSafeEqual
// are not available in the Edge runtime.
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { calculateFee } from '@/lib/finance';
import {
  verifyWebhookSignature,
  parseWebhookBody,
  type DecryptedWebhook,
  type WebhookPaymentPayload,
} from '@/lib/payments/peach/webhook';
import { classifyResultCode } from '@/lib/payments/peach/resultCodes';
import { saveCardForPatient as saveCardForPatientPeach } from '@/lib/payments/peach/saveCardForPatient';
import { sendPushToUser } from '@/lib/notifications/sendPush';
import { advanceLadderAfterFailure, chargeAmountCents } from '@/lib/payments/dunning';
import {
  notifyAttemptFailed,
  notifyDefaulted,
  notifyRecoverySucceeded,
} from '@/lib/payments/dunningNotifications';
import { getPaymentProvider } from '@/lib/payments/provider';
import crypto from 'node:crypto';

// ─── Peach Checkout V2 webhook receiver ─────────────────────────────
//
// V2 webhooks are signed, not encrypted. Headers:
//   • x-webhook-signature-algorithm — 'HMAC-SHA256'
//   • x-webhook-timestamp           — timestamp
//   • x-webhook-signature           — hex HMAC digest
// Body: plaintext JSON { type, action?, payload }.
//
// The webhook is authoritative on CIT state (Flow A first instalment,
// Flow B card-registration completion). For MIT charges (instalments
// 2+) the synchronous recurring response is authoritative; the webhook
// is a bonus reconciliation channel — every state flip is guarded by a
// status precondition so double-delivery is a no-op.

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

// ─── First-payment activation (shared by checkout + silent paths) ──

async function activateFirstPayment(
  supabase: ReturnType<typeof svc>,
  payment:  { id: string },
  plan:     { id: string; total_amount: unknown; practice_id: unknown; provider_id?: string | null },
  now:      string,
): Promise<boolean> {
  const { error: pmtErr } = await supabase
    .from('payments')
    .update({ status: 'collected', collected_at: now })
    .eq('id', payment.id);
  if (pmtErr) {
    console.error('[peach-webhook] activateFirstPayment: failed to mark instalment 1 collected', pmtErr.message);
    return false;
  }

  const { error: planErr } = await supabase
    .from('plans')
    .update({ status: 'active' })
    .eq('id', plan.id);
  if (planErr) {
    console.error('[peach-webhook] activateFirstPayment: failed to activate plan', planErr.message);
    return false;
  }

  const { data: practice } = await supabase
    .from('practices')
    .select('fee_percent')
    .eq('id', plan.practice_id as string)
    .single();

  const feePercent = Number(practice?.fee_percent ?? 6);
  const { gross, fee, net } = calculateFee(Number(plan.total_amount), feePercent);

  const payoutRow: Record<string, unknown> = {
    id:           crypto.randomUUID(),
    practice_id:  plan.practice_id as string,
    plan_id:      plan.id,
    gross_amount: gross,
    fee_amount:   fee,
    net_amount:   net,
    status:       'pending',
    payout_destination: 'practice',
  };

  if (plan.provider_id) {
    payoutRow.provider_id = plan.provider_id;

    const { data: member } = await supabase
      .from('practice_members')
      .select('payout_destination, personal_bank_name, personal_account_holder, personal_account_number, personal_branch_code, personal_account_type')
      .eq('user_id', plan.provider_id)
      .eq('practice_id', plan.practice_id as string)
      .maybeSingle();

    if (member?.payout_destination === 'provider') {
      payoutRow.payout_destination        = 'provider';
      payoutRow.snapshot_bank_name        = member.personal_bank_name        ?? null;
      payoutRow.snapshot_account_holder   = member.personal_account_holder   ?? null;
      payoutRow.snapshot_account_number   = member.personal_account_number   ?? null;
      payoutRow.snapshot_branch_code      = member.personal_branch_code      ?? null;
      payoutRow.snapshot_account_type     = member.personal_account_type     ?? null;
    }
  }

  const { error: payoutErr } = await supabase.from('payouts').insert(payoutRow);
  if (payoutErr) {
    // Non-fatal
    console.error('[peach-webhook] activateFirstPayment: failed to insert payout', payoutErr.message);
  }

  return true;
}

// ─── Payment-success dispatch ──────────────────────────────────────

async function handlePaymentSuccess(payload: WebhookPaymentPayload): Promise<void> {
  const reference = payload.merchantTransactionId;
  if (!reference) {
    console.warn('[peach-webhook] payment.success: missing merchantTransactionId — cannot reconcile');
    return;
  }
  const supabase = svc();

  // Refund events arrive as PAYMENT + paymentType=RF. Route them.
  if (payload.paymentType === 'RF') {
    await handleRefundSuccess(supabase, payload);
    return;
  }

  const { data: payment } = await supabase
    .from('payments')
    .select('id, plan_id, instalment_number, patient_id, status, retry_count, dunning_fees_cents, amount, kind')
    .eq('peach_payment_id', reference)
    .maybeSingle();

  // Standalone card-registration path — no payment row; just save the card.
  if (!payment && reference.startsWith('hnpl_reg_')) {
    await handleCardRegistrationSuccess(supabase, payload);
    return;
  }

  if (!payment) {
    console.warn('[peach-webhook] payment.success: no payment row for reference', reference);
    return;
  }

  if (payment.kind === 'settlement') {
    await handleSettlementChargeSuccess(supabase, payment, reference);
    return;
  }

  const { data: plan } = await supabase
    .from('plans')
    .select('id, status, total_amount, practice_id, patient_id, provider_id, payment_provider, peach_initial_transaction_id')
    .eq('id', payment.plan_id)
    .maybeSingle();

  if (!plan) {
    console.error('[peach-webhook] payment.success: plan not found', payment.plan_id);
    return;
  }

  const now = new Date().toISOString();

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
              brand:          payload.card.paymentBrand ?? null,
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

    const activated = await activateFirstPayment(supabase, payment, plan, now);
    if (activated) {
      console.log('[peach-webhook] payment.success: plan activated', { planId: plan.id, reference });
      await safePush(plan.patient_id, {
        type:  'plan',
        title: 'Plan activated',
        body:  `Your ${formatRandCents(Number(plan.total_amount))} plan is live. We'll handle the rest.`,
        url:   `/patient/orders/${plan.id}`,
        tag:   `plan:${plan.id}:activated`,
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
      status:            'collected',
      collected_at:      now,
      next_attempt_date: null,
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

  if (payload.paymentType === 'RF') {
    await handleRefundFailure(supabase, payload);
    return;
  }

  const { data: payment } = await supabase
    .from('payments')
    .select('id, plan_id, instalment_number, status, amount, consecutive_failed_attempts, dunning_fees_cents, retry_count, kind, pre_settlement_snapshot')
    .eq('peach_payment_id', reference)
    .maybeSingle();

  if (!payment && reference.startsWith('hnpl_reg_')) {
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
    console.log('[peach-webhook] payment.failure: plan cancelled', { planId: plan.id, reference, failureReason });
    return;
  }

  if (payment.status === 'failed' || payment.status === 'defaulted') {
    console.log('[peach-webhook] payment.failure: instalment already in terminal/failed state (duplicate)', { paymentId: payment.id, reference, status: payment.status });
    return;
  }

  const todayUtc      = new Date().toISOString().slice(0, 10);
  const feesBefore    = (payment.dunning_fees_cents ?? 0) as number;
  const counterBefore = (payment.consecutive_failed_attempts ?? 0) as number;
  const attemptedAmountCents = chargeAmountCents(Number(payment.amount), feesBefore);

  const ladder = advanceLadderAfterFailure({
    consecutiveFailedAttemptsBefore: counterBefore,
    dunningFeesCentsBefore:          feesBefore,
    originalBillRands:               Number(plan.total_amount),
    today:                           todayUtc,
  });

  const newStatus: 'failed' | 'defaulted' = ladder.terminalStatus ?? 'failed';

  await supabase
    .from('payments')
    .update({
      status:                      newStatus,
      failure_reason:              failureReason,
      consecutive_failed_attempts: ladder.consecutiveFailedAttemptsAfter,
      dunning_fees_cents:          ladder.dunningFeesCentsAfter,
      next_attempt_date:           ladder.nextAttemptDate,
    })
    .eq('id', payment.id);

  const planEventInserts: Record<string, unknown>[] = [
    {
      plan_id:    plan.id,
      patient_id: plan.patient_id,
      event_type: 'instalment_attempt_failed',
      payload: {
        payment_id:                        payment.id,
        instalment_number:                 payment.instalment_number,
        failure_reason:                    failureReason,
        consecutive_failed_attempts_after: ladder.consecutiveFailedAttemptsAfter,
        next_attempt_date:                 ladder.nextAttemptDate,
      },
    },
  ];
  if (ladder.feeAppliedThisAttempt > 0) {
    planEventInserts.push({
      plan_id:    plan.id,
      patient_id: plan.patient_id,
      event_type: 'dunning_fee_applied',
      payload: {
        payment_id:               payment.id,
        instalment_number:        payment.instalment_number,
        fee_applied_cents:        ladder.feeAppliedThisAttempt,
        dunning_fees_cents_after: ladder.dunningFeesCentsAfter,
      },
    });
  }
  if (ladder.capReached) {
    planEventInserts.push({
      plan_id:    plan.id,
      patient_id: plan.patient_id,
      event_type: 'instalment_defaulted',
      payload: {
        payment_id:               payment.id,
        instalment_number:        payment.instalment_number,
        outstanding_amount_cents: chargeAmountCents(Number(payment.amount), ladder.dunningFeesCentsAfter),
      },
    });
  }
  await supabase.from('plan_events').insert(planEventInserts);

  await notifyAttemptFailed(supabase, {
    paymentId:                       payment.id,
    consecutiveFailedAttemptsBefore: counterBefore,
    feeAppliedCents:                 ladder.feeAppliedThisAttempt,
    dunningFeesCentsAfter:           ladder.dunningFeesCentsAfter,
    attemptedAmountCents,
    nextAttemptDate:                 ladder.nextAttemptDate,
  });
  if (ladder.capReached) {
    await notifyDefaulted(supabase, {
      paymentId:              payment.id,
      outstandingAmountCents: chargeAmountCents(Number(payment.amount), ladder.dunningFeesCentsAfter),
    });
  }
  if (plan.patient_id) {
    await safePush(plan.patient_id, {
      title: 'Payment didn\'t go through',
      body:  ladder.feeAppliedThisAttempt > 0
        ? `We couldn't collect ${formatRandCents(attemptedAmountCents / 100)}. A ${formatRandCents(ladder.feeAppliedThisAttempt / 100)} fee was added. Tap to settle now and stop further fees.`
        : `We couldn't collect ${formatRandCents(attemptedAmountCents / 100)}. We'll try again — fund your card now or settle to avoid further fees.`,
      url:   `/patient/orders`,
      tag:   `payment:${payment.id}:failed:r${payment.retry_count ?? 0}`,
    });
  }
}

// ─── Standalone card-registration ──────────────────────────────────

async function handleCardRegistrationSuccess(supabase: ReturnType<typeof svc>, payload: WebhookPaymentPayload): Promise<void> {
  const patientId = payload.customParameters?.SHOPPER_patientId ?? payload.customParameters?.patientId;
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
        brand:          payload.card.paymentBrand ?? null,
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
): Promise<void> {
  if (settlement.status === 'collected') {
    console.log('[peach-webhook] settlement payment.success: already collected (duplicate)', { settlementId: settlement.id, reference });
    return;
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

// ─── Refund lifecycle ──────────────────────────────────────────────

async function handleRefundSuccess(supabase: ReturnType<typeof svc>, payload: WebhookPaymentPayload): Promise<void> {
  const txRef      = payload.merchantTransactionId;
  const peachId    = payload.id ?? null;
  if (!txRef) return;
  const now = new Date().toISOString();
  await supabase
    .from('refunds')
    .upsert({
      transaction_reference: txRef,
      amount_cents:          payload.amount ? Math.round(Number(payload.amount) * 100) : 100,
      reason:                'card_registration',
      status:                'processed',
      peach_refund_id:       peachId,
      processed_at:          now,
      last_event_at:         now,
      raw_event:             payload,
    }, { onConflict: 'transaction_reference' });
}

async function handleRefundFailure(supabase: ReturnType<typeof svc>, payload: WebhookPaymentPayload): Promise<void> {
  const txRef      = payload.merchantTransactionId;
  const peachId    = payload.id ?? null;
  if (!txRef) return;
  const now = new Date().toISOString();
  await supabase
    .from('refunds')
    .upsert({
      transaction_reference: txRef,
      amount_cents:          payload.amount ? Math.round(Number(payload.amount) * 100) : 100,
      reason:                'card_registration',
      status:                'failed',
      peach_refund_id:       peachId,
      failure_reason:        payload.result?.description ?? 'Refund failed',
      last_event_at:         now,
      raw_event:             payload,
    }, { onConflict: 'transaction_reference' });
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

export async function POST(request: NextRequest) {
  const algorithm = request.headers.get('x-webhook-signature-algorithm');
  const timestamp = request.headers.get('x-webhook-timestamp');
  const signature = request.headers.get('x-webhook-signature');
  const secret    = process.env.PEACH_CHECKOUT_SECRET_TOKEN;

  if (!secret) {
    console.error('[peach-webhook] PEACH_CHECKOUT_SECRET_TOKEN is not set');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const body = await request.text();

  const valid = verifyWebhookSignature({
    body,
    algorithm,
    timestamp,
    signature,
    secret,
  });

  if (!valid) {
    console.warn('[peach-webhook] HMAC verification failed — request ignored');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const parsed: DecryptedWebhook | null = parseWebhookBody(body);
  if (!parsed) {
    console.warn('[peach-webhook] Body did not parse into a valid webhook payload');
    // 200 — signature was authentic; payload is malformed. Peach
    // shouldn't retry a genuinely malformed body; log and move on.
    return NextResponse.json({ received: true, note: 'unprocessable payload' }, { status: 200 });
  }

  const { type, action, payload } = parsed;

  console.log('[peach-webhook] Event received:', {
    type,
    action,
    reference:  (payload as WebhookPaymentPayload).merchantTransactionId,
    resultCode: (payload as WebhookPaymentPayload).result?.code,
  });

  try {
    if (type === 'PAYMENT') {
      const p = payload as WebhookPaymentPayload;
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
      console.log('[peach-webhook] Unhandled event type — acknowledging without action', { type, action });
    }
  } catch (err) {
    // NEVER re-throw — non-200 would trigger Peach's retry ladder and
    // could double-fire state flips. Log and 200.
    console.error('[peach-webhook] Handler threw — swallowing to preserve 200 ACK', err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// Not used from the route directly, but exported so we can verify
// the provider is wired in tests without instantiating the full route.
export const __internals = { getPaymentProvider };
