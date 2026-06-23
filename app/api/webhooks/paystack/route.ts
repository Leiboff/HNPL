// Node.js runtime required — we use crypto.createHmac and crypto.timingSafeEqual
// which are not available in the Edge runtime.
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { calculateFee } from '@/lib/finance';
import { paystackRequest } from '@/lib/paystack';
import {
  saveCardForPatient as saveCardForPatientShared,
  type PaystackAuthorization,
} from '@/lib/paystack/saveCardForPatient';
import { sendPushToUser } from '@/lib/notifications/sendPush';
import { advanceLadderAfterFailure, chargeAmountCents } from '@/lib/payments/dunning';
import {
  notifyAttemptFailed,
  notifyDefaulted,
  notifyRecoverySucceeded,
} from '@/lib/payments/dunningNotifications';

// Note: the middleware (proxy.ts / updateSession) only refreshes Supabase session
// cookies and never redirects — so this unauthenticated route is unaffected by it.

// ─── Service-role client ──────────────────────────────────────────────────────
// Bypasses RLS — correct here because the request is authenticated by Paystack's
// HMAC signature above, not by a user session. Never expose this key.

function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ─── Paystack types ───────────────────────────────────────────────────────────

type Authorization = {
  authorization_code?: string;
  last4?:              string;
  exp_month?:          string | number;
  exp_year?:           string | number;
  brand?:              string;
  reusable?:           boolean;
  account_name?:       string;
  signature?:          string;
};

type ChargeMetadata = {
  purpose?:   string;
  patientId?: string;
  [key: string]: unknown;
};

type ChargeData = {
  reference?:        string;
  amount?:           number;
  status?:           string;
  message?:          string;
  gateway_response?: string;
  authorization?:    Authorization;
  metadata?:         ChargeMetadata;
};

type PaystackPayload = {
  event: string;
  data:  ChargeData;
};

type PaystackRefundResponse = {
  status:  boolean;
  message: string;
  data?: {
    id?:     number;
    status?: string;
    transaction?: { reference?: string };
  };
};

// ─── Card-save helper ────────────────────────────────────────────────────────
// Thin wrapper around the shared lib helper. Both the first-payment
// activation path and the card-registration path call this; both treat a
// SaveCardResult.kind === 'error' as non-fatal (logged + swallowed) so the
// webhook still acks 200 to Paystack and the rest of the side effects
// (refund, plan activation) still run.

async function saveCardForPatient(
  patientId: string,
  auth: Authorization,
  supabase: ReturnType<typeof createServiceClient>,
): Promise<void> {
  const result = await saveCardForPatientShared(patientId, auth as PaystackAuthorization, supabase);
  if (result.kind === 'error') {
    throw new Error(result.message);
  }
}

// ─── Push notification helpers (best-effort, never block the webhook) ────────
//
// Wrappers around lib/notifications/sendPush that:
//   • format a payload appropriate to the payment event;
//   • dedupe via `tag` so a redelivered webhook doesn't pile up
//     duplicate toasts in the patient's tray;
//   • swallow ALL errors — a push failure must not fail the webhook,
//     which would cause Paystack to retry the entire charge.success
//     handler and risk double-activating the plan.

function formatRandCents(rands: number): string {
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

// Webhook-local helper. Defaults `type` so each call site only has to
// specify the category when it differs from the default — keeps the
// per-event call sites short while still ensuring `type` is always
// present in the payload (the sender now requires it).
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
    console.warn('[paystack-webhook] push send failed (non-fatal)', {
      userId,
      message: (err as Error).message,
    });
  }
}

// ─── First-payment activation helper ─────────────────────────────────────────
// Shared by the checkout path and the silent (saved-card) path.
// Marks instalment 1 as collected, activates the plan, and creates a payout.
// Returns true on full success so the caller can emit a success log line.

async function activateFirstPayment(
  supabase: ReturnType<typeof createServiceClient>,
  payment:  { id: string },
  plan:     { id: string; total_amount: unknown; practice_id: unknown; provider_id?: string | null },
  now:      string,
): Promise<boolean> {
  const { error: pmtErr } = await supabase
    .from('payments')
    .update({ status: 'collected', collected_at: now })
    .eq('id', payment.id);
  if (pmtErr) {
    console.error('[paystack-webhook] activateFirstPayment: failed to mark instalment 1 collected', pmtErr.message);
    return false;
  }

  const { error: planErr } = await supabase
    .from('plans')
    .update({ status: 'active' })
    .eq('id', plan.id);
  if (planErr) {
    console.error('[paystack-webhook] activateFirstPayment: failed to activate plan', planErr.message);
    return false;
  }

  const { data: practice } = await supabase
    .from('practices')
    .select('fee_percent')
    .eq('id', plan.practice_id as string)
    .single();

  const feePercent = Number(practice?.fee_percent ?? 6);
  const { gross, fee, net } = calculateFee(Number(plan.total_amount), feePercent);

  // Build payout row — route to provider's personal account if configured
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
    // Non-fatal — plan is active; payout can be reconciled via admin
    console.error('[paystack-webhook] activateFirstPayment: failed to insert payout', payoutErr.message);
  }

  return true;
}

// ─── charge.success handler ───────────────────────────────────────────────────

async function handleChargeSuccess(data: ChargeData): Promise<void> {
  const reference = data.reference;
  const supabase  = createServiceClient();

  const { data: payment } = await supabase
    .from('payments')
    .select('id, plan_id, instalment_number, patient_id, status, retry_count, dunning_fees_cents, amount')
    .eq('peach_payment_id', reference)
    .maybeSingle();

  if (!payment) {
    console.warn('[paystack-webhook] charge.success: no payment row for reference', reference);
    return;
  }

  const { data: plan } = await supabase
    .from('plans')
    .select('id, status, total_amount, practice_id, patient_id, provider_id')
    .eq('id', payment.plan_id)
    .maybeSingle();

  if (!plan) {
    console.error('[paystack-webhook] charge.success: plan not found', payment.plan_id);
    return;
  }

  const now = new Date().toISOString();

  // ── Instalment 1: first-payment activation ───────────────────────────────

  if (payment.instalment_number === 1) {
    // Idempotency: webhook fired again after we already activated
    if (plan.status === 'active') {
      console.log('[paystack-webhook] charge.success: plan already active (duplicate)', plan.id);
      return;
    }
    if (plan.status !== 'pending_first_payment') {
      console.warn('[paystack-webhook] charge.success: unexpected plan status for instalment 1', plan.status);
      return;
    }

    const auth    = data.authorization;
    const purpose = data.metadata?.purpose;

    if (purpose === 'first_instalment_silent') {
      // ── Silent charge path (saved-card, no checkout) ──────────────────────
      // Card is already in payment_methods. Store the auth code so instalment
      // 2/3 recurring debits work, then activate the plan — no card save needed.
      if (auth?.authorization_code) {
        const { error: authCodeErr } = await supabase
          .from('plans')
          .update({ paystack_authorization_code: auth.authorization_code })
          .eq('id', plan.id);
        if (authCodeErr) {
          // Non-fatal — plan still activates; admin can set auth code manually if needed
          console.error('[paystack-webhook] charge.success (silent): failed to store auth code', authCodeErr.message);
        }
      }
      const activated = await activateFirstPayment(supabase, payment, plan, now);
      if (activated) {
        console.log('[paystack-webhook] charge.success (silent): plan activated', { planId: plan.id, reference });
        // Plan-lifecycle push, not a payment one — categorised so the
        // patient could one day choose to mute payment-only updates
        // without missing plan activations.
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

    // ── Checkout path (original flow) ────────────────────────────────────────

    // Reusable guard — critical: a non-reusable card cannot be used for future debits
    if (!auth?.reusable) {
      console.warn('[paystack-webhook] charge.success: authorization not reusable — skipping activation', { reference });
      return;
    }

    const authCode = auth.authorization_code!;

    // Store the authorization code on the plan for future instalment charges
    const { error: authCodeErr } = await supabase
      .from('plans')
      .update({ paystack_authorization_code: authCode })
      .eq('id', plan.id);
    if (authCodeErr) {
      console.error('[paystack-webhook] charge.success: failed to store auth code', authCodeErr.message);
      return;
    }

    // Save the card — non-fatal; plan activation proceeds regardless.
    try {
      await saveCardForPatient(plan.patient_id, auth, supabase);
    } catch (pmSaveErr) {
      console.error(
        '[paystack-webhook] charge.success: failed to save payment_methods (non-fatal)',
        pmSaveErr instanceof Error ? pmSaveErr.message : pmSaveErr,
      );
    }

    const activated = await activateFirstPayment(supabase, payment, plan, now);
    if (activated) {
      console.log('[paystack-webhook] charge.success: plan activated', { planId: plan.id, reference });
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

  // ── Instalments 2 / 3: recurring collection ──────────────────────────────

  // Idempotency: webhook fired again for an already-collected instalment
  if (payment.status === 'collected') {
    console.log('[paystack-webhook] charge.success: instalment already collected (duplicate)', { paymentId: payment.id, reference });
    return;
  }

  const wasRecovery =
    Number(payment.retry_count ?? 0) > 1 ||
    Number(payment.dunning_fees_cents ?? 0) > 0;

  // Clear ladder scheduling state — the row is terminal-collected now,
  // no further attempts. dunning_fees_cents stays as-is so the row
  // records what was actually collected (instalment + fees, if any).
  const { error: pmtErr } = await supabase
    .from('payments')
    .update({
      status:            'collected',
      collected_at:      now,
      next_attempt_date: null,
    })
    .eq('id', payment.id);
  if (pmtErr) {
    console.error('[paystack-webhook] charge.success: failed to mark instalment collected', pmtErr.message);
    return;
  }

  if (wasRecovery) {
    const collectedCents =
      Math.round(Number(payment.amount) * 100) +
      Number(payment.dunning_fees_cents ?? 0);
    const { error: evErr } = await supabase.from('plan_events').insert({
      plan_id:    plan.id,
      patient_id: plan.patient_id,
      event_type: 'instalment_attempt_succeeded',
      payload: {
        payment_id:           payment.id,
        instalment_number:    payment.instalment_number,
        collected_amount_cents: collectedCents,
        via_self_settle:      false,
      },
    });
    if (evErr) {
      console.error('[paystack-webhook] charge.success: plan_events insert failed (non-fatal)', evErr.message);
    }
    await notifyRecoverySucceeded(supabase, {
      paymentId:            payment.id,
      collectedAmountCents: collectedCents,
      viaSelfSettle:        false,
    });
  }

  // If every instalment is now collected, mark the plan completed
  const { data: remaining } = await supabase
    .from('payments')
    .select('id')
    .eq('plan_id', plan.id)
    .neq('status', 'collected');

  if (!remaining || remaining.length === 0) {
    await supabase
      .from('plans')
      .update({ status: 'completed', completed_at: now })
      .eq('id', plan.id);
    console.log('[paystack-webhook] charge.success: plan completed', { planId: plan.id });
    // Final-instalment push — collected + plan finished in one breath.
    // Classified as 'plan' (lifecycle), not 'payment', so it sits in
    // the same category as activation + future plan-state events.
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
    console.log('[paystack-webhook] charge.success: instalment collected', {
      paymentId:        payment.id,
      instalmentNumber: payment.instalment_number,
      planId:           plan.id,
    });
    // Mid-plan instalment collected push.
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

// ─── charge.failed handler ────────────────────────────────────────────────────

async function handleChargeFailed(data: ChargeData): Promise<void> {
  const reference = data.reference;
  const supabase  = createServiceClient();

  const { data: payment } = await supabase
    .from('payments')
    .select('id, plan_id, instalment_number, status, amount, consecutive_failed_attempts, dunning_fees_cents, retry_count')
    .eq('peach_payment_id', reference)
    .maybeSingle();

  if (!payment) {
    console.warn('[paystack-webhook] charge.failed: no payment row for reference', reference);
    return;
  }

  const { data: plan } = await supabase
    .from('plans')
    .select('id, status, patient_id, total_amount')
    .eq('id', payment.plan_id)
    .maybeSingle();

  if (!plan) {
    console.error('[paystack-webhook] charge.failed: plan not found', payment.plan_id);
    return;
  }

  const failureReason = data.gateway_response ?? data.message ?? 'Charge failed';

  // ── Instalment 1: cancel the plan (patient never paid; practice not yet paid) ──

  if (payment.instalment_number === 1) {
    if (plan.status === 'cancelled') {
      console.log('[paystack-webhook] charge.failed: plan already cancelled (duplicate)', plan.id);
      return;
    }
    if (plan.status !== 'pending_first_payment') {
      console.warn('[paystack-webhook] charge.failed: unexpected plan status for instalment 1', plan.status);
      return;
    }

    const { error: pmtErr } = await supabase
      .from('payments')
      .update({ status: 'failed', failure_reason: failureReason })
      .eq('id', payment.id);
    if (pmtErr) {
      console.error('[paystack-webhook] charge.failed: failed to mark instalment 1 failed', pmtErr.message);
      return;
    }

    const { error: planErr } = await supabase
      .from('plans')
      .update({ status: 'cancelled' })
      .eq('id', plan.id);
    if (planErr) {
      console.error('[paystack-webhook] charge.failed: failed to cancel plan', planErr.message);
      return;
    }

    console.log('[paystack-webhook] charge.failed: plan cancelled', { planId: plan.id, reference, failureReason });
    return;
  }

  // ── Instalments 2 / 3: mark failed, leave plan active ────────────────────
  // The practice payout is already created; this is HNPL's collection risk.

  if (payment.status === 'failed' || payment.status === 'defaulted') {
    // Idempotency: redelivered failure webhook (status is already past
    // the failure-handling point). Bail before re-advancing the ladder
    // or re-emitting the failure notification.
    console.log('[paystack-webhook] charge.failed: instalment already in terminal/failed state (duplicate)', { paymentId: payment.id, reference, status: payment.status });
    return;
  }

  // ── Advance the dunning ladder. Pure math; the new state is what we
  //    persist next. The "today" anchor for the next-attempt-date math
  //    is the UTC date of the failure event — same calendar day the
  //    cron uses on its next run.
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

  const { error: pmtErr } = await supabase
    .from('payments')
    .update({
      status:                      newStatus,
      failure_reason:              failureReason,
      consecutive_failed_attempts: ladder.consecutiveFailedAttemptsAfter,
      dunning_fees_cents:          ladder.dunningFeesCentsAfter,
      next_attempt_date:           ladder.nextAttemptDate,
    })
    .eq('id', payment.id);
  if (pmtErr) {
    console.error('[paystack-webhook] charge.failed: failed to mark instalment failed', pmtErr.message);
    return;
  }

  // ── Audit trail. One row per ladder event. plan_events RLS lets the
  //    patient read their own rows; the admin sees everything. Errors
  //    are non-fatal — the actual state is on the payment row.
  const planEventInserts: Record<string, unknown>[] = [
    {
      plan_id:    plan.id,
      patient_id: plan.patient_id,
      event_type: 'instalment_attempt_failed',
      payload: {
        payment_id:        payment.id,
        instalment_number: payment.instalment_number,
        failure_reason:    failureReason,
        consecutive_failed_attempts_after: ladder.consecutiveFailedAttemptsAfter,
        next_attempt_date: ladder.nextAttemptDate,
      },
    },
  ];
  if (ladder.feeAppliedThisAttempt > 0) {
    planEventInserts.push({
      plan_id:    plan.id,
      patient_id: plan.patient_id,
      event_type: 'dunning_fee_applied',
      payload: {
        payment_id:                 payment.id,
        instalment_number:          payment.instalment_number,
        fee_applied_cents:          ladder.feeAppliedThisAttempt,
        dunning_fees_cents_after:   ladder.dunningFeesCentsAfter,
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
  const { error: eventsErr } = await supabase.from('plan_events').insert(planEventInserts);
  if (eventsErr) {
    console.error('[paystack-webhook] charge.failed: plan_events insert failed (non-fatal)', eventsErr.message);
  }

  console.log('[paystack-webhook] charge.failed: ladder advanced', {
    paymentId:                       payment.id,
    instalmentNumber:                payment.instalment_number,
    planId:                          plan.id,
    failureReason,
    feeApplied:                      ladder.feeAppliedThisAttempt,
    dunningFeesAfter:                ladder.dunningFeesCentsAfter,
    consecutiveAfter:                ladder.consecutiveFailedAttemptsAfter,
    nextAttempt:                     ladder.nextAttemptDate,
    capReached:                      ladder.capReached,
    newStatus,
  });

  // ── Patient-facing notifications. Sender failures must NEVER fail
  //    the webhook (which would cause Paystack to retry the whole
  //    handler and risk duplicate ladder-advances). Both helpers wrap
  //    in try/catch internally; the per-channel pushes also self-swallow.
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

// ─── card_registration handlers ──────────────────────────────────────────────

async function handleCardRegistrationSuccess(data: ChargeData): Promise<void> {
  const reference = data.reference;
  const patientId = data.metadata?.patientId;
  const supabase  = createServiceClient();
  const auth      = data.authorization;

  if (!patientId) {
    console.error('[paystack-webhook] card_registration: missing patientId in metadata', { reference });
    // Still refund — we don't keep money we can't attribute
  }

  if (patientId && auth?.reusable) {
    try {
      await saveCardForPatient(patientId, auth, supabase);
    } catch (err) {
      console.error(
        '[paystack-webhook] card_registration: failed to save card (non-fatal)',
        err instanceof Error ? err.message : err,
      );
    }
  } else if (!auth?.reusable) {
    console.warn('[paystack-webhook] card_registration: card not reusable — skipping save', { reference });
  }

  // ── Record refund intent before calling Paystack ──────────────────────────
  // Upsert is idempotent: duplicate charge.success webhooks won't create two rows.
  const { error: upsertErr } = await supabase
    .from('refunds')
    .upsert({
      transaction_reference: reference,
      patient_id:            patientId ?? null,
      amount_cents:          data.amount ?? 100,
      reason:                'card_registration',
      status:                'initiated',
      initiated_at:          new Date().toISOString(),
      raw_event:             data,
    }, { onConflict: 'transaction_reference' });
  if (upsertErr) {
    console.error('[paystack-webhook] card_registration: failed to record refund row', upsertErr.message, { reference });
  }

  // Always refund the R1 charge, regardless of whether the card was saved
  try {
    const refundRes = await paystackRequest<PaystackRefundResponse>('/refund', {
      method: 'POST',
      body:   JSON.stringify({ transaction: reference }),
    });
    const paystackRefundId = refundRes.data?.id ? String(refundRes.data.id) : null;
    await supabase
      .from('refunds')
      .update({
        status:             'pending',
        paystack_refund_id: paystackRefundId,
        last_event_at:      new Date().toISOString(),
      })
      .eq('transaction_reference', reference);
    console.log('[paystack-webhook] card_registration: R1 refund initiated', { reference, paystackRefundId });
  } catch (refundErr) {
    const failureReason = refundErr instanceof Error ? refundErr.message : 'Unknown error';
    await supabase
      .from('refunds')
      .update({
        status:         'failed',
        failure_reason: failureReason,
        last_event_at:  new Date().toISOString(),
      })
      .eq('transaction_reference', reference);
    console.error(
      '[paystack-webhook] card_registration: refund FAILED — manual follow-up needed',
      failureReason,
      { reference },
    );
  }
}

function handleCardRegistrationFailed(data: ChargeData): void {
  // Charge never went through — nothing to refund, nothing to save
  console.log('[paystack-webhook] card_registration: charge failed — no action needed', {
    reference: data.reference,
    reason:    data.gateway_response ?? data.message ?? 'unknown',
  });
}

// ─── Refund lifecycle handlers ────────────────────────────────────────────────
// Paystack fires refund.pending / refund.processed / refund.failed after the
// initial POST /refund call. These keep the `refunds` row in sync.
//
// Confirmed payload shape (data object):
//   data.transaction_reference  — flat string, the original charge reference
//   data.id                     — string, Paystack's refund ID
//   data.amount                 — integer cents
//   data.merchant_note          — failure reason (refund.failed only)

type RefundEventData = {
  transaction_reference?: string;
  id?:                    string;
  amount?:                number;
  status?:                string;
  merchant_note?:         string | null;
};

async function handleRefundPending(data: ChargeData): Promise<void> {
  const rd         = data as unknown as RefundEventData;
  const txRef      = rd.transaction_reference;
  const paystackId = rd.id ?? null;
  const supabase   = createServiceClient();
  const now        = new Date().toISOString();

  if (!txRef) {
    console.warn('[paystack-webhook] refund.pending: no transaction_reference in payload');
    return;
  }

  // Upsert handles the normal case (row already exists from charge.success handling)
  // AND the race case where refund.pending fires before our POST /refund response
  // is written back to the DB.
  const { error } = await supabase
    .from('refunds')
    .upsert({
      transaction_reference: txRef,
      amount_cents:          rd.amount ?? 100,
      reason:                'card_registration',
      status:                'pending',
      paystack_refund_id:    paystackId,
      last_event_at:         now,
      raw_event:             data,
    }, { onConflict: 'transaction_reference' });

  if (error) {
    console.error('[paystack-webhook] refund.pending: DB upsert failed', error.message, { txRef });
  } else {
    console.log('[paystack-webhook] refund.pending: status=pending', { txRef, paystackId });
  }
}

async function handleRefundProcessed(data: ChargeData): Promise<void> {
  const rd         = data as unknown as RefundEventData;
  const txRef      = rd.transaction_reference;
  const paystackId = rd.id ?? null;
  const supabase   = createServiceClient();
  const now        = new Date().toISOString();

  if (!txRef) {
    console.warn('[paystack-webhook] refund.processed: no transaction_reference in payload');
    return;
  }

  const { error } = await supabase
    .from('refunds')
    .upsert({
      transaction_reference: txRef,
      amount_cents:          rd.amount ?? 100,
      reason:                'card_registration',
      status:                'processed',
      paystack_refund_id:    paystackId,
      processed_at:          now,
      last_event_at:         now,
      raw_event:             data,
    }, { onConflict: 'transaction_reference' });

  if (error) {
    console.error('[paystack-webhook] refund.processed: DB upsert failed', error.message, { txRef });
  } else {
    console.log('[paystack-webhook] refund.processed: status=processed', { txRef, paystackId });
  }
}

async function handleRefundFailed(data: ChargeData): Promise<void> {
  const rd            = data as unknown as RefundEventData;
  const txRef         = rd.transaction_reference;
  const paystackId    = rd.id ?? null;
  const failureReason = rd.merchant_note ?? 'Refund failed';
  const supabase      = createServiceClient();
  const now           = new Date().toISOString();

  if (!txRef) {
    console.warn('[paystack-webhook] refund.failed: no transaction_reference in payload');
    return;
  }

  const { error } = await supabase
    .from('refunds')
    .upsert({
      transaction_reference: txRef,
      amount_cents:          rd.amount ?? 100,
      reason:                'card_registration',
      status:                'failed',
      paystack_refund_id:    paystackId,
      failure_reason:        failureReason,
      last_event_at:         now,
      raw_event:             data,
    }, { onConflict: 'transaction_reference' });

  if (error) {
    console.error('[paystack-webhook] refund.failed: DB upsert failed', error.message, { txRef });
  } else {
    console.error('[paystack-webhook] refund.failed: status=failed — manual follow-up needed', { txRef, paystackId, failureReason });
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // ── 1. Read raw body as text BEFORE any JSON parsing ───────────────────────
  // Paystack signs the raw bytes; parsing first would invalidate the signature.
  const rawBody = await request.text();

  // ── 2. Signature verification ───────────────────────────────────────────────
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error('[paystack-webhook] PAYSTACK_SECRET_KEY is not set');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const receivedSig = request.headers.get('x-paystack-signature') ?? '';
  const expectedSig = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  // timingSafeEqual requires equal-length buffers.
  // Buffer.from(<str>, 'hex') silently drops non-hex chars, producing a shorter
  // buffer — the length check below catches that safely.
  const receivedBuf = Buffer.from(receivedSig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');

  const signatureValid =
    receivedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(receivedBuf, expectedBuf);

  if (!signatureValid) {
    console.warn('[paystack-webhook] Invalid signature — request ignored');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // ── 3. Parse ────────────────────────────────────────────────────────────────
  let payload: PaystackPayload;
  try {
    payload = JSON.parse(rawBody) as PaystackPayload;
  } catch {
    console.error('[paystack-webhook] Failed to parse JSON body');
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { event, data } = payload;

  console.log('[paystack-webhook] Event received:', {
    event,
    reference: data.reference,
    amount:    data.amount,
    status:    data.status,
  });

  // ── 4. Dispatch ─────────────────────────────────────────────────────────────
  // Refund lifecycle events are handled first — they have a different payload
  // shape and no metadata.purpose, so they must not reach the charge handlers.
  const purpose = data.metadata?.purpose;

  if (event === 'refund.pending') {
    await handleRefundPending(data);
  } else if (event === 'refund.processed') {
    await handleRefundProcessed(data);
  } else if (event === 'refund.failed') {
    await handleRefundFailed(data);
  } else if (purpose === 'card_registration') {
    if (event === 'charge.success') {
      await handleCardRegistrationSuccess(data);
    } else if (event === 'charge.failed') {
      handleCardRegistrationFailed(data);
    } else {
      console.log('[paystack-webhook] card_registration: unhandled event — ignoring:', event);
    }
  } else if (event === 'charge.success') {
    await handleChargeSuccess(data);
  } else if (event === 'charge.failed') {
    await handleChargeFailed(data);
  } else {
    console.log('[paystack-webhook] Unhandled event type — ignoring:', event);
  }

  // ── 5. Acknowledge ──────────────────────────────────────────────────────────
  return NextResponse.json({ received: true }, { status: 200 });
}
